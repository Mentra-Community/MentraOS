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
  public static final String RECOVERY_HEARTBEAT_PERMISSION =
      "com.mentra.recovery.permission.HEARTBEAT";
  public static final String RECOVERY_CONTROL_PERMISSION =
      "com.mentra.recovery.permission.CONTROL";
  public static final String ASG_SERVICE_CLASS = "com.mentra.asg_client.service.core.AsgClientService";
  public static final String ACTION_RESTART_SERVICE = "com.mentra.asg_client.ACTION_RESTART_SERVICE";

  public static final String ACTION_START_RECOVERY = "com.mentra.recovery.ACTION_START_RECOVERY";
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

  /** Normal cadence while ASG is responsive. */
  public static final long HEARTBEAT_INTERVAL_MS = 20_000L;
  /** Accelerated cadence after at least one missed heartbeat. */
  public static final long HEARTBEAT_FAST_INTERVAL_MS = 10_000L;
  public static final long HEARTBEAT_TIMEOUT_MS = 25_000L;
  public static final long HEARTBEAT_FAST_TIMEOUT_MS = 12_000L;
  public static final int MAX_MISSED_HEARTBEATS = 3;
  public static final long RESTART_GRACE_MS = 20000L;
  public static final long REINSTALL_GRACE_MS = 60000L;

  /**
   * How long the reinstall path keeps the install lock after dispatching the backup install,
   * waiting for the installed versionCode to reach the backup's. The OEM install is asynchronous;
   * releasing the lock at dispatch would let a downgrade begin while the higher backup install is
   * still in flight.
   */
  public static final long REINSTALL_OBSERVE_TIMEOUT_MS = 60000L;

  /**
   * How long the downgrade worker keeps its transaction alive after first observing the target
   * version, re-checking that the version holds. A recovery backup install that outlived the
   * reinstall observe window could otherwise commit right after convergence, with the
   * transaction already cleared and no WAIT_FOR_REVERT left to re-uninstall it. During the
   * linger any higher build that (re)appears resumes the state machine instead.
   */
  public static final long DOWNGRADE_CONVERGENCE_LINGER_MS = 60000L;

  /** Poll cadence while lingering at the converged target version. */
  public static final long DOWNGRADE_LINGER_POLL_MS = 5000L;
  public static final long REINSTALL_LATE_PONG_GRACE_MS = 30000L;
  public static final long RECOVERY_WINDOW_MS = 30 * 60 * 1000L;
  public static final int MAX_RECOVERIES_PER_WINDOW = 3;
  public static final long COOLDOWN_MS = 30_000L;
  /**
   * Max time to trust an in-flight recovery state without worker completion. Covers restart,
   * reinstall, and late-heartbeat grace windows with buffer for package-manager latency.
   */
  public static final long IN_FLIGHT_RECOVERY_STALE_MS = 3 * 60 * 1000L;
  /**
   * Max time to honor an install pause without {@link #ACTION_INSTALL_COMPLETED}. Covers typical
   * OTA reboot windows; resumes monitoring if the completion signal is never received.
   */
  public static final long INSTALL_PAUSE_MAX_MS = 5 * 60 * 1000L;

  public static final String UNIQUE_RECOVERY_WORK = "mentra_recovery_oneshot";

  public static final String BACKUP_APK_PATH = "/storage/emulated/0/asg/asg_client_backup.apk";
  public static final String BACKUP_METADATA_PATH = "/storage/emulated/0/asg/asg_client_backup.json";


  // --- Pinned ASG downgrade transaction (uninstall-then-reinstall detour) ---

  /** ASG hands off a staged, checksummed downgrade APK for recovery to install. */
  public static final String ACTION_REQUEST_DOWNGRADE = "com.mentra.recovery.ACTION_REQUEST_DOWNGRADE";
  public static final String EXTRA_DOWNGRADE_TARGET_VERSION = "target_version_code";
  public static final String EXTRA_DOWNGRADE_APK_PATH = "apk_path";
  public static final String EXTRA_DOWNGRADE_APK_SHA256 = "apk_sha256";

  public static final String DOWNGRADE_PREFS = "mentra_downgrade_transaction";
  public static final String UNIQUE_DOWNGRADE_WORK = "mentra_downgrade_transaction";

  /**
   * Oldest ASG versionCode a downgrade transaction may target. Mirrors ASG's
   * {@code OtaConstants.DOWNGRADE_FLOOR_VERSION_CODE} as defense in depth (this package updates
   * independently of ASG): builds below the floor predate the downgrade-safe contract (media
   * storage layout, post-uninstall behavior). Mentra 3.0 is the first release shipping that
   * contract. A non-positive floor disables recovery-side downgrades entirely.
   */
  public static final long DOWNGRADE_FLOOR_VERSION_CODE = 51518114L;

  /** Uninstall broadcast dispatch until the factory /system revert is observed. */
  public static final long DOWNGRADE_REVERT_TIMEOUT_MS = 90_000L;
  /** Install broadcast dispatch until the target versionCode is observed installed. */
  public static final long DOWNGRADE_INSTALL_TIMEOUT_MS = 120_000L;
  /** Installed-version poll cadence while a downgrade phase is in flight. */
  public static final long DOWNGRADE_POLL_INTERVAL_MS = 2_000L;
  /** Install broadcast attempts before the transaction gives up. */
  public static final int DOWNGRADE_MAX_INSTALL_ATTEMPTS = 3;
  /**
   * Abandon a transaction that has not converged after this long. Generous because the
   * transaction legitimately spans the uninstall revert, an install, and process restarts.
   */
  public static final long DOWNGRADE_TRANSACTION_STALE_MS = 30 * 60 * 1000L;

  /**
   * Verdict broadcast sent back to ASG synchronously from the handoff decision: ASG cannot
   * otherwise distinguish a refused handoff from an accepted-but-slow transaction (its
   * watchdog only observes "still alive"), and that ambiguity is what made blind retry
   * dangerous. Guarded like the heartbeat channel.
   */
  public static final String ACTION_DOWNGRADE_HANDOFF_RESULT =
      "com.mentra.recovery.ACTION_DOWNGRADE_HANDOFF_RESULT";

  public static final String EXTRA_HANDOFF_ACCEPTED = "accepted";
  public static final String EXTRA_HANDOFF_TARGET_VERSION = "target_version";
  public static final String EXTRA_HANDOFF_REASON = "reason";

  /**
   * Suffix appended when the accepted transaction claims the staged APK by rename. Renaming
   * (atomic within the filesystem) transfers artifact ownership to the transaction, so a
   * later ASG re-stage writes a DIFFERENT file and can never corrupt the bytes a live
   * DowngradeWorker validates and installs.
   */
  public static final String DOWNGRADE_CLAIMED_APK_SUFFIX = ".txn";
}
