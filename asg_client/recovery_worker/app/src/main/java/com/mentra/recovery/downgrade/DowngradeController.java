package com.mentra.recovery.downgrade;

import android.content.Context;
import android.content.Intent;
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
      sendHandoffResult(context, false, targetVersion, "floor_rejected");
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
      sendHandoffResult(context, false, targetVersion, "worker_busy");
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
        sendHandoffResult(context, false, targetVersion, "transaction_active");
        return;
      }
      // Claim the staged artifact by rename BEFORE persisting the transaction: from here the
      // bytes belong to this transaction, and any later ASG re-stage writes the original
      // (unclaimed) filename — a retry can never corrupt what the worker installs.
      String claimedPath = claimStagedApk(apkPath);
      if (claimedPath == null) {
        Log.e(
            RecoveryConstants.TAG,
            "Refusing downgrade handoff: could not claim staged APK at " + apkPath);
        sendHandoffResult(context, false, targetVersion, "artifact_claim_failed");
        return;
      }
      if (!store.begin(targetVersion, claimedPath, apkSha256)) {
        Log.e(
            RecoveryConstants.TAG,
            "Rejected downgrade handoff (target=" + targetVersion + ", path=" + claimedPath + ")");
        sendHandoffResult(context, false, targetVersion, "invalid_request");
        return;
      }
    } finally {
      DowngradeTransactionStore.installLock().unlock();
    }
    Log.i(
        RecoveryConstants.TAG,
        "Downgrade transaction begun: target=" + targetVersion + ", apk=" + apkPath);
    enqueue(context, ExistingWorkPolicy.REPLACE);
    sendHandoffResult(context, true, targetVersion, "accepted");
  }

  /** Renames the staged APK to its transaction-owned name; returns the new path or null. */
  private static String claimStagedApk(String apkPath) {
    try {
      java.io.File staged = new java.io.File(apkPath);
      if (!staged.isFile()) {
        return null;
      }
      java.io.File claimed =
          new java.io.File(apkPath + RecoveryConstants.DOWNGRADE_CLAIMED_APK_SUFFIX);
      if (claimed.exists() && !claimed.delete()) {
        return null;
      }
      return staged.renameTo(claimed) ? claimed.getAbsolutePath() : null;
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to claim staged APK", e);
      return null;
    }
  }

  /** Synchronous verdict back to ASG so it can tell refused from accepted-but-slow. */
  private static void sendHandoffResult(
      Context context, boolean accepted, long targetVersion, String reason) {
    try {
      Intent result = new Intent(RecoveryConstants.ACTION_DOWNGRADE_HANDOFF_RESULT);
      result.setPackage(RecoveryConstants.ASG_PACKAGE);
      result.putExtra(RecoveryConstants.EXTRA_HANDOFF_ACCEPTED, accepted);
      result.putExtra(RecoveryConstants.EXTRA_HANDOFF_TARGET_VERSION, targetVersion);
      result.putExtra(RecoveryConstants.EXTRA_HANDOFF_REASON, reason);
      context.sendBroadcast(result, RecoveryConstants.RECOVERY_HEARTBEAT_PERMISSION);
      Log.i(
          RecoveryConstants.TAG,
          "Handoff verdict sent: accepted=" + accepted + ", reason=" + reason);
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to send handoff verdict", e);
    }
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
