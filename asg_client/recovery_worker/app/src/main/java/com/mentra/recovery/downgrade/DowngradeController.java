package com.mentra.recovery.downgrade;

import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.Operation;
import androidx.work.WorkManager;

import java.io.File;
import java.util.concurrent.TimeUnit;

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
    // the pin once the current transaction has converged or given up. tryLock stays
    // non-blocking by design even though we now run on the handoff executor: refusal-with-
    // verdict IS the protocol (the phone re-offers), and queueing behind a worker would just
    // delay the verdict ASG's watchdog is timing. It doubles as the is-a-worker-running
    // probe; stale transactions cannot wedge this path forever because
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
      File claimed = ArtifactClaims.claim(apkPath == null ? null : new File(apkPath));
      if (claimed == null) {
        Log.e(
            RecoveryConstants.TAG,
            "Refusing downgrade handoff: could not claim staged APK at " + apkPath);
        sendHandoffResult(context, false, targetVersion, "artifact_claim_failed");
        return;
      }
      // "Accepted" is a promise of ownership: everything that can be known to fail must fail
      // BEFORE the verdict. Run the worker's full validation (bytes + archive: sha256, package,
      // exact version, testOnly, signer match) here — a mis-published or wrongly-signed
      // artifact is refused instead of accepted-then-abandoned on the supervision timer. We
      // run on the receiver's handoff executor (not the main thread), so hashing is fine.
      String invalid =
          StagedApkValidator.validate(
              context, claimed.getAbsolutePath(), apkSha256, targetVersion);
      if (invalid != null) {
        Log.e(RecoveryConstants.TAG, "Refusing downgrade handoff: staged APK " + invalid);
        ArtifactClaims.unclaim(claimed);
        sendHandoffResult(context, false, targetVersion, "staged_apk_" + invalid);
        return;
      }
      if (!store.begin(targetVersion, claimed.getAbsolutePath(), apkSha256)) {
        Log.e(
            RecoveryConstants.TAG,
            "Rejected downgrade handoff (target=" + targetVersion + ", path=" + claimed + ")");
        ArtifactClaims.unclaim(claimed);
        sendHandoffResult(context, false, targetVersion, "invalid_request");
        return;
      }
      // Acceptance must follow a CONFIRMED enqueue: a begun transaction with no worker is
      // unrecoverable from the outside (handoffs refuse on transaction_active, and the stale
      // give-up only runs inside a worker). On enqueue failure, roll everything back and
      // refuse so ownership never dangles.
      if (!enqueueConfirmed(context)) {
        store.clear();
        ArtifactClaims.unclaim(claimed);
        Log.e(RecoveryConstants.TAG, "Refusing downgrade handoff: could not enqueue worker");
        sendHandoffResult(context, false, targetVersion, "enqueue_failed");
        return;
      }
    } finally {
      DowngradeTransactionStore.installLock().unlock();
    }
    Log.i(
        RecoveryConstants.TAG,
        "Downgrade transaction begun: target=" + targetVersion + ", apk=" + apkPath);
    sendHandoffResult(context, true, targetVersion, "accepted");
  }

  /**
   * Blocking enqueue with confirmation, run on the handoff executor. WorkManager's enqueue is
   * asynchronous under the hood; observing the Operation result is the only way to know the
   * worker will actually exist before promising ownership.
   */
  private static boolean enqueueConfirmed(Context context) {
    try {
      OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(DowngradeWorker.class).build();
      Operation op =
          WorkManager.getInstance(context)
              .enqueueUniqueWork(
                  RecoveryConstants.UNIQUE_DOWNGRADE_WORK, ExistingWorkPolicy.REPLACE, request);
      op.getResult().get(10, TimeUnit.SECONDS);
      return true;
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Downgrade work enqueue failed/unconfirmed", e);
      return false;
    }
  }

  /** Synchronous verdict back to ASG so it can tell refused from accepted-but-slow. */
  static void sendHandoffResult(
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
