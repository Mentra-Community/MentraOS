package com.mentra.recovery.work;

import android.content.Context;
import android.os.SystemClock;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import com.mentra.recovery.install.AsgInstallTransactionStore;
import com.mentra.recovery.util.RecoveryConstants;
import com.mentra.recovery.util.SystemInstaller;
import java.io.File;

/** Retries an interrupted exact ASG install without depending on ASG-owned state. */
public final class AsgInstallRetryWorker extends Worker {
  public AsgInstallRetryWorker(@NonNull Context context, @NonNull WorkerParameters params) {
    super(context, params);
  }

  @NonNull
  @Override
  public Result doWork() {
    Context context = getApplicationContext();
    AsgInstallTransactionStore store = new AsgInstallTransactionStore(context);
    if (!store.hasPending() || store.reconcileInstalledVersion()) {
      return Result.success();
    }
    if (!store.isReadyToInstall()) {
      if (store.isUnarmedExpired(
          System.currentTimeMillis(), RecoveryConstants.ASG_INSTALL_ARM_TIMEOUT_MS)) {
        long target = store.targetAsgVersion();
        Log.e(RecoveryConstants.TAG, "Expiring unarmed ASG install target " + target);
        return store.cancel(target) ? Result.success() : Result.retry();
      }
      Log.w(
          RecoveryConstants.TAG,
          "Pending ASG downgrade is not armed because its state reset was not confirmed");
      return Result.retry();
    }

    File targetApk = new File(RecoveryConstants.ASG_UPDATE_APK_PATH);
    if (!store.pendingArtifactMatches(targetApk)) {
      Log.e(
          RecoveryConstants.TAG,
          "Cannot retry pending ASG install: staged target is absent or invalid");
      return Result.retry();
    }

    Log.w(
        RecoveryConstants.TAG,
        "Retrying pending exact ASG install target " + store.targetAsgVersion());
    if (!new SystemInstaller(context)
        .installApk(targetApk.getAbsolutePath(), RecoveryConstants.ASG_PACKAGE)) {
      return Result.retry();
    }

    long deadline =
        SystemClock.elapsedRealtime() + RecoveryConstants.ASG_INSTALL_VERIFY_TIMEOUT_MS;
    while (SystemClock.elapsedRealtime() < deadline) {
      if (store.reconcileInstalledVersion()) {
        return Result.success();
      }
      try {
        Thread.sleep(2_000L);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        return Result.retry();
      }
    }
    Log.e(RecoveryConstants.TAG, "Pending exact ASG install was not confirmed after retry");
    return Result.retry();
  }
}
