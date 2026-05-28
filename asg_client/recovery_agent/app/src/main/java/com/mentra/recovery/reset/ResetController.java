package com.mentra.recovery.reset;

import android.content.Context;

import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;

import com.mentra.recovery.telemetry.RecoveryTelemetry;
import com.mentra.recovery.work.RecoveryWorker;
import com.mentra.recovery.util.RecoveryConstants;

public class ResetController {
  private final Context context;
  private final RecoveryStateStore stateStore;
  private final RecoveryTelemetry telemetry;

  public ResetController(Context context) {
    this.context = context.getApplicationContext();
    this.stateStore = new RecoveryStateStore(context);
    this.telemetry = new RecoveryTelemetry(context);
  }

  public void onAsgUnresponsive() {
    long now = System.currentTimeMillis();
    long windowStart = stateStore.getWindowStartMs();
    int attempts = stateStore.getAttempts();
    if (windowStart == 0 || now - windowStart > RecoveryConstants.RECOVERY_WINDOW_MS) {
      windowStart = now;
      attempts = 0;
    }
    attempts++;
    stateStore.setWindowStartMs(windowStart);
    stateStore.setAttempts(attempts);
    if (attempts > RecoveryConstants.MAX_RECOVERIES_PER_WINDOW) {
      stateStore.setState(RecoveryConstants.STATE_FAILED_NEEDS_MANUAL, "TOO_MANY_ATTEMPTS");
      telemetry.emit("mentra_recovery_failed", RecoveryConstants.STATE_FAILED_NEEDS_MANUAL, "TOO_MANY_ATTEMPTS", attempts);
      return;
    }
    stateStore.setState(RecoveryConstants.STATE_RESTARTING, "HEARTBEAT_TIMEOUT");
    telemetry.emit("mentra_recovery_state_changed", RecoveryConstants.STATE_RESTARTING, "HEARTBEAT_TIMEOUT", attempts);
    OneTimeWorkRequest request =
        new OneTimeWorkRequest.Builder(RecoveryWorker.class)
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .build();
    WorkManager.getInstance(context)
        .enqueueUniqueWork(RecoveryConstants.UNIQUE_RECOVERY_WORK, ExistingWorkPolicy.KEEP, request);
  }

  public void onAsgHealthy() {
    stateStore.setState(RecoveryConstants.STATE_HEALTHY, "HEARTBEAT_OK");
  }
}
