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
    // No lock here on purpose: this runs on a broadcast receiver's main thread, where blocking
    // behind a worker that legitimately holds the install lock for tens of seconds would ANR.
    // Persisting the transaction is safe at any time — install serialization lives in the
    // workers: RecoveryWorker holds the install lock across its check + reinstall + observed
    // completion, and DowngradeWorker takes the same lock before dispatching anything, so it
    // blocks until any in-flight recovery install has observably finished.
    if (!store.begin(targetVersion, apkPath, apkSha256)) {
      Log.e(
          RecoveryConstants.TAG,
          "Rejected downgrade handoff (target=" + targetVersion + ", path=" + apkPath + ")");
      return;
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
