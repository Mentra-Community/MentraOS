package com.mentra.recovery.downgrade;

import android.content.Context;
import android.util.Log;

import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import com.mentra.recovery.util.RecoveryConstants;

/** Entry points for beginning and resuming the pinned-downgrade transaction. */
public final class DowngradeController {
  private DowngradeController() {}

  /** Persists a fresh transaction from an ASG handoff and starts driving it. */
  public static void requestDowngrade(
      Context context, long targetVersion, String apkPath, String apkSha256) {
    // Fail closed, mirroring ASG's DowngradeGate: a non-positive floor means downgrades are not
    // enabled for this release channel, so reject regardless of target.
    if (RecoveryConstants.DOWNGRADE_FLOOR_VERSION_CODE <= 0
        || targetVersion < RecoveryConstants.DOWNGRADE_FLOOR_VERSION_CODE) {
      Log.e(
          RecoveryConstants.TAG,
          "Rejected downgrade handoff (floor="
              + RecoveryConstants.DOWNGRADE_FLOOR_VERSION_CODE
              + ", target="
              + targetVersion
              + ")");
      return;
    }
    DowngradeTransactionStore store = new DowngradeTransactionStore(context);
    // Never REPLACE a live transaction: begin() clears and rewrites the store, and a running
    // DowngradeWorker caches its target once but reads apkPath/sha/attempts from the store
    // dynamically — an overwrite mid-run would make it mix the old target with the new
    // transaction's fields and later clear the replacement. A handoff that arrives while a
    // transaction is active (or while a worker holds the install lock) is refused; ASG's
    // handoff watchdog then reports failure to the phone, whose reconciliation loop re-offers
    // the pin once the current transaction has converged or given up. tryLock (non-blocking,
    // we are on a broadcast receiver's main thread — no waiting allowed) doubles as the
    // is-a-worker-running probe; stale transactions cannot wedge this path forever because
    // resumeIfActive re-arms them and DOWNGRADE_TRANSACTION_STALE_MS forces give-up.
    if (!DowngradeTransactionStore.installLock().tryLock()) {
      Log.w(
          RecoveryConstants.TAG,
          "Refusing downgrade handoff: an install worker is running (target="
              + targetVersion
              + ")");
      return;
    }
    try {
      if (store.isActive()) {
        Log.w(
            RecoveryConstants.TAG,
            "Refusing downgrade handoff: a transaction is already active (existing target="
                + store.getTargetVersion()
                + ", new target="
                + targetVersion
                + ")");
        return;
      }
      if (!store.begin(targetVersion, apkPath, apkSha256)) {
        Log.e(
            RecoveryConstants.TAG,
            "Rejected downgrade handoff (target=" + targetVersion + ", path=" + apkPath + ")");
        return;
      }
    } finally {
      DowngradeTransactionStore.installLock().unlock();
    }
    Log.i(
        RecoveryConstants.TAG,
        "Downgrade transaction begun: target=" + targetVersion + ", apk=" + apkPath);
    enqueue(context, ExistingWorkPolicy.REPLACE);
  }

  /** Re-arms the worker for a transaction that survived a reboot or process death. */
  public static void resumeIfActive(Context context) {
    if (!new DowngradeTransactionStore(context).isActive()) {
      return;
    }
    Log.i(RecoveryConstants.TAG, "Resuming persisted downgrade transaction");
    enqueue(context, ExistingWorkPolicy.KEEP);
  }

  private static void enqueue(Context context, ExistingWorkPolicy policy) {
    try {
      // No network constraint: the APK is already staged and checksummed on local storage.
      OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(DowngradeWorker.class).build();
      WorkManager.getInstance(context)
          .enqueueUniqueWork(RecoveryConstants.UNIQUE_DOWNGRADE_WORK, policy, request);
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to enqueue downgrade work", e);
    }
  }
}
