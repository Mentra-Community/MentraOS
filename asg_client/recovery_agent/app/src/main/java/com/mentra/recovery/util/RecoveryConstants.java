package com.mentra.recovery.util;

public final class RecoveryConstants {
  private RecoveryConstants() {}

  public static final String TAG = "MentraRecovery";
  public static final String CHANNEL_ID = "mentra_recovery_channel";
  public static final int NOTIFICATION_ID = 2101;

  public static final String RECOVERY_PACKAGE = "com.mentra.recovery";
  public static final String ASG_PACKAGE = "com.mentra.asg_client";
  public static final String ASG_TELEMETRY_PERMISSION =
      "com.mentra.asg_client.permission.RECOVERY_TELEMETRY";
  public static final String ASG_SERVICE_CLASS = "com.mentra.asg_client.service.core.AsgClientService";
  public static final String ACTION_RESTART_SERVICE = "com.mentra.asg_client.ACTION_RESTART_SERVICE";

  public static final String ACTION_PING = "com.mentra.recovery.ACTION_PING";
  public static final String ACTION_PONG = "com.mentra.recovery.ACTION_PONG";
  public static final String ACTION_INSTALL_IN_PROGRESS = "com.mentra.recovery.ACTION_INSTALL_IN_PROGRESS";
  public static final String ACTION_INSTALL_COMPLETED = "com.mentra.recovery.ACTION_INSTALL_COMPLETED";
  public static final String ACTION_TELEMETRY = "com.mentra.recovery.ACTION_TELEMETRY";

  public static final String STATE_PREFS = "mentra_recovery_state";
  public static final String KEY_STATE = "state";
  public static final String KEY_REASON = "reason";
  public static final String KEY_ATTEMPTS = "attempts";
  public static final String KEY_WINDOW_START_MS = "window_start_ms";
  public static final String KEY_LAST_TRANSITION_MS = "last_transition_ms";

  public static final String STATE_HEALTHY = "HEALTHY";
  public static final String STATE_SUSPECTED_DEAD = "SUSPECTED_DEAD";
  public static final String STATE_RESTARTING = "RESTARTING";
  public static final String STATE_REINSTALLING_BACKUP = "REINSTALLING_BACKUP";
  public static final String STATE_COOLDOWN = "COOLDOWN";
  public static final String STATE_FAILED_NEEDS_MANUAL = "FAILED_NEEDS_MANUAL";

  public static final long HEARTBEAT_INTERVAL_MS = 6000L;
  public static final long HEARTBEAT_TIMEOUT_MS = 10000L;
  public static final int MAX_MISSED_HEARTBEATS = 3;
  public static final long RESTART_GRACE_MS = 20000L;
  public static final long REINSTALL_GRACE_MS = 60000L;
  public static final long RECOVERY_WINDOW_MS = 30 * 60 * 1000L;
  public static final int MAX_RECOVERIES_PER_WINDOW = 3;
  public static final long COOLDOWN_MS = 30_000L;

  public static final String UNIQUE_RECOVERY_WORK = "mentra_recovery_oneshot";

  public static final String BACKUP_APK_PATH = "/storage/emulated/0/asg/asg_client_backup.apk";
  public static final String BACKUP_METADATA_PATH = "/storage/emulated/0/asg/asg_client_backup.json";
}
