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
   * ({@link #begin(long, String, String)}) deliberately does NOT take the lock — it runs on a
   * broadcast receiver's main thread where blocking risks an ANR, and persisting the transaction
   * is safe at any time because the workers, not the handoff, dispatch installs. Both workers run
   * on WorkManager threads in the recovery app's single process, so a process-wide lock is a true
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
    if (targetVersion <= 0 || apkPath == null || apkPath.isEmpty()) {
      return false;
    }
    return preferences
        .edit()
        .clear()
        .putLong(KEY_TARGET_VERSION, targetVersion)
        .putString(KEY_APK_PATH, apkPath)
        .putString(KEY_APK_SHA256, apkSha256 == null ? "" : apkSha256)
        .putBoolean(KEY_UNINSTALL_REQUESTED, false)
        .putInt(KEY_INSTALL_ATTEMPTS, 0)
        .putLong(KEY_STARTED_AT_MS, System.currentTimeMillis())
        .commit();
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
