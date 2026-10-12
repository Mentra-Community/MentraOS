package com.mentra.recovery.downgrade;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.concurrent.locks.ReentrantLock;

import com.mentra.recovery.util.RecoveryConstants;

/**
 * Recovery-owned persistence for one in-flight pinned-downgrade transaction.
 *
 * <p>Lives in the recovery worker's own SharedPreferences because the uninstall that anchors the
 * detour wipes every ASG-owned preference store. All writes are synchronous ({@code commit}) so a
 * transaction survives the process death the very next step is expected to cause.
 */
public final class DowngradeTransactionStore {
  /**
   * Serializes ASG (re)install work inside the recovery process. A double-check of
   * {@link #isActive()} narrows but cannot close the window in which heartbeat recovery decides
   * ASG is dead just before a downgrade handoff persists a transaction — recovery would then
   * reinstall the higher fleet backup while the downgrade runs. Because the OEM install is an
   * asynchronous broadcast, holders must keep the lock until their install is OBSERVABLY
   * complete, not merely dispatched: {@code RecoveryWorker} holds it across its pre-reinstall
   * check, the reinstall dispatch, and a bounded wait for the backup versionCode to be installed;
   * {@code DowngradeWorker} holds it for its whole state-machine run. The handoff itself
   * is serialized on the control executor, uses tryLock(), and holds the lock through artifact
   * validation, persistence and enqueue. Both workers run in the recovery app's single process,
   * so this lock provides true install
   * serialization.
   */
  private static final ReentrantLock INSTALL_LOCK = new ReentrantLock();

  private static final String KEY_TARGET_VERSION = "target_version_code";
  private static final String KEY_APK_PATH = "apk_path";
  private static final String KEY_APK_SHA256 = "apk_sha256";
  private static final String KEY_UNINSTALL_REQUESTED = "uninstall_requested";
  private static final String KEY_INSTALL_ATTEMPTS = "install_attempts";
  private static final String KEY_STARTED_AT_MS = "started_at_ms";

  private final SharedPreferences preferences;

  /** The process-wide install serialization lock; see {@link #INSTALL_LOCK}. */
  public static ReentrantLock installLock() {
    return INSTALL_LOCK;
  }

  public DowngradeTransactionStore(Context context) {
    preferences =
        context
            .getApplicationContext()
            .getSharedPreferences(RecoveryConstants.DOWNGRADE_PREFS, Context.MODE_PRIVATE);
  }

  /**
   * Starts a transaction. Callers must ensure no transaction is active and no install worker is
   * running (see DowngradeController.requestDowngrade): the clear+rewrite would otherwise pull
   * the store out from under a live worker.
   */
  @SuppressWarnings("ApplySharedPref")
  public boolean begin(long targetVersion, String apkPath, String apkSha256) {
    return begin(java.util.UUID.randomUUID().toString(), targetVersion, apkPath, apkSha256);
  }

  @SuppressWarnings("ApplySharedPref")
  public boolean begin(String requestId, long targetVersion, String apkPath, String apkSha256) {
    if (targetVersion <= 0 || apkPath == null || apkPath.isEmpty()) {
      return false;
    }
    return preferences
        .edit()
        .clear()
        .putString(RecoveryConstants.KEY_REQUEST_ID, requestId)
        .putLong(KEY_TARGET_VERSION, targetVersion)
        .putString(KEY_APK_PATH, apkPath)
        .putString(KEY_APK_SHA256, apkSha256 == null ? "" : apkSha256)
        .putBoolean(KEY_UNINSTALL_REQUESTED, false)
        .putInt(KEY_INSTALL_ATTEMPTS, 0)
        .putLong(KEY_STARTED_AT_MS, System.currentTimeMillis())
        .commit();
  }

  /** Backfill identity when v11 resumes a transaction persisted by v10. */
  @SuppressWarnings("ApplySharedPref")
  public String getRequestId() {
    synchronized (preferences) {
      String id = preferences.getString(RecoveryConstants.KEY_REQUEST_ID, "");
      if (id.isEmpty() && isActive()) {
        id = java.util.UUID.randomUUID().toString();
        if (!preferences.edit().putString(RecoveryConstants.KEY_REQUEST_ID, id).commit()) return "";
      }
      return id;
    }
  }

  /** Snapshot one atomic preference commit; active identity survives ASG uninstall/restart. */
  public android.os.Bundle snapshot() {
    getRequestId();
    java.util.Map<String, ?> values = preferences.getAll();
    android.os.Bundle result = new android.os.Bundle();
    Object target = values.get(KEY_TARGET_VERSION);
    result.putLong("target_version", target instanceof Long ? (Long) target : -1L);
    result.putString("transaction_id", (String) values.get(RecoveryConstants.KEY_REQUEST_ID));
    result.putString("sha256", (String) values.get(KEY_APK_SHA256));
    result.putString("terminal_reason", (String) values.get(RecoveryConstants.KEY_TERMINAL_REASON));
    result.putBoolean("active", target instanceof Long && (Long) target > 0);
    return result;
  }

  /** Retain the last terminal identity while releasing ownership in a single durable commit. */
  @SuppressWarnings("ApplySharedPref")
  public boolean finish(String reason) {
    return preferences.edit().remove(KEY_TARGET_VERSION).remove(KEY_APK_PATH)
        .putString(RecoveryConstants.KEY_TERMINAL_REASON, reason).commit();
  }

  public boolean isActive() {
    return getTargetVersion() > 0;
  }

  public long getTargetVersion() {
    return preferences.getLong(KEY_TARGET_VERSION, -1L);
  }

  public String getApkPath() {
    return preferences.getString(KEY_APK_PATH, "");
  }

  public String getApkSha256() {
    return preferences.getString(KEY_APK_SHA256, "");
  }

  public boolean isUninstallRequested() {
    return preferences.getBoolean(KEY_UNINSTALL_REQUESTED, false);
  }

  public int getInstallAttempts() {
    return preferences.getInt(KEY_INSTALL_ATTEMPTS, 0);
  }

  public long getStartedAtMs() {
    return preferences.getLong(KEY_STARTED_AT_MS, 0L);
  }

  @SuppressWarnings("ApplySharedPref")
  public boolean markUninstallRequested() {
    return preferences.edit().putBoolean(KEY_UNINSTALL_REQUESTED, true).commit();
  }

  @SuppressWarnings("ApplySharedPref")
  public boolean incrementInstallAttempts() {
    return preferences.edit().putInt(KEY_INSTALL_ATTEMPTS, getInstallAttempts() + 1).commit();
  }

  @SuppressWarnings("ApplySharedPref")
  public boolean clear() {
    return preferences.edit().clear().commit();
  }
}
