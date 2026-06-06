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
    String currentState = stateStore.getState();
    if (RecoveryConstants.STATE_RESTARTING.equals(currentState)
        || RecoveryConstants.STATE_REINSTALLING_BACKUP.equals(currentState)) {
      return;
    }
    if (RecoveryConstants.STATE_COOLDOWN.equals(currentState)
        && isWithinCooldownWindow()) {
      return;
    }
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
      telemetry.emit(
          "mentra_recovery_failed", RecoveryConstants.STATE_FAILED_NEEDS_MANUAL, "TOO_MANY_ATTEMPTS", attempts, false);
      return;
    }
    stateStore.setState(RecoveryConstants.STATE_RESTARTING, "HEARTBEAT_TIMEOUT");
    telemetry.emit(
        "mentra_recovery_state_changed", RecoveryConstants.STATE_RESTARTING, "HEARTBEAT_TIMEOUT", attempts, false);
    OneTimeWorkRequest request =
        new OneTimeWorkRequest.Builder(RecoveryWorker.class)
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .build();
    WorkManager.getInstance(context)
        .enqueueUniqueWork(RecoveryConstants.UNIQUE_RECOVERY_WORK, ExistingWorkPolicy.KEEP, request);
  }

  public void onAsgHealthy() {
    WorkManager.getInstance(context).cancelUniqueWork(RecoveryConstants.UNIQUE_RECOVERY_WORK);

    String currentState = stateStore.getState();
    if (RecoveryConstants.STATE_HEALTHY.equals(currentState)) {
      return;
    }

    int attempts = stateStore.getAttempts();
    String reason =
        RecoveryConstants.STATE_FAILED_NEEDS_MANUAL.equals(currentState)
            ? "LATE_HEARTBEAT_AFTER_FAILED_MANUAL"
            : "HEARTBEAT_OK";

    // Worker already emitted mentra_recovery_recovered on success; avoid duplicate telemetry.
    if (RecoveryConstants.STATE_COOLDOWN.equals(currentState)) {
      stateStore.setState(RecoveryConstants.STATE_HEALTHY, reason);
      stateStore.setAttempts(0);
      stateStore.setWindowStartMs(0L);
      return;
    }

    // Heartbeat is authoritative: if ASG is alive, clear degraded state and reset retry window.
    stateStore.setState(RecoveryConstants.STATE_HEALTHY, reason);
    stateStore.setAttempts(0);
    stateStore.setWindowStartMs(0L);
    telemetry.emit(
        "mentra_recovery_recovered", RecoveryConstants.STATE_HEALTHY, reason, attempts, true);
  }

  private boolean isWithinCooldownWindow() {
    long elapsed = System.currentTimeMillis() - stateStore.getLastTransitionMs();
    return elapsed >= 0 && elapsed < RecoveryConstants.COOLDOWN_MS;
  }
}
