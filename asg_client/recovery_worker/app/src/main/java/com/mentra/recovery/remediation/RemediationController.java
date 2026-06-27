package com.mentra.recovery.remediation;

import android.content.Context;
import android.util.Log;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.mentra.recovery.util.RecoveryConstants;

import java.util.concurrent.TimeUnit;

/**
 * Schedules the {@link RemediationWorker}: a periodic network-gated check plus a one-time prompt run
 * shortly after the recovery service starts (covers boot).
 */
public final class RemediationController {
  private RemediationController() {}

  public static void schedule(Context context) {
    try {
      Constraints constraints =
          new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();

      PeriodicWorkRequest periodic =
          new PeriodicWorkRequest.Builder(
                  RemediationWorker.class,
                  RecoveryConstants.REMEDIATION_CHECK_INTERVAL_HOURS,
                  TimeUnit.HOURS)
              .setConstraints(constraints)
              .build();
      WorkManager.getInstance(context)
          .enqueueUniquePeriodicWork(
              RecoveryConstants.UNIQUE_REMEDIATION_WORK,
              ExistingPeriodicWorkPolicy.KEEP,
              periodic);

      OneTimeWorkRequest prompt =
          new OneTimeWorkRequest.Builder(RemediationWorker.class)
              .setConstraints(constraints)
              .build();
      WorkManager.getInstance(context)
          .enqueueUniqueWork(
              RecoveryConstants.UNIQUE_REMEDIATION_WORK + "_boot",
              ExistingWorkPolicy.KEEP,
              prompt);
      Log.i(RecoveryConstants.TAG, "Remediation work scheduled");
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to schedule remediation work", e);
    }
  }
}
