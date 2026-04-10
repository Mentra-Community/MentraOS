package com.mentra.asg_client.reporting.incidentlogs;

import android.content.Context;
import android.util.Log;

import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

/**
 * Thin wrapper around WorkManager for scheduling incident log uploads.
 *
 * <p>Uses unique work with {@link ExistingWorkPolicy#KEEP} so multiple enqueues
 * (rapid bug reports, startup sweep) coalesce into a single worker run.</p>
 */
public class IncidentLogUploadScheduler {

  private static final String TAG = "IncidentLogUploadSched";
  private static final String UNIQUE_WORK_NAME = "incident-log-upload";

  /**
   * Schedule a drain of the pending incident log queue.
   *
   * <p>If a worker is already pending or running, this is a no-op
   * (ExistingWorkPolicy.KEEP). Safe to call frequently.</p>
   *
   * @param context application or service context
   */
  public static void scheduleDrain(Context context) {
    try {
      Constraints constraints = new Constraints.Builder()
          .setRequiredNetworkType(NetworkType.CONNECTED)
          .build();

      OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(IncidentLogUploadWorker.class)
          .setConstraints(constraints)
          .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
          .build();

      WorkManager.getInstance(context)
          .enqueueUniqueWork(UNIQUE_WORK_NAME, ExistingWorkPolicy.KEEP, request);

      Log.d(TAG, "Scheduled incident log upload drain");
    } catch (Exception e) {
      Log.e(TAG, "Failed to schedule incident log upload", e);
    }
  }
}
