package com.mentra.recovery.service;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.mentra.recovery.downgrade.DowngradeController;
import com.mentra.recovery.downgrade.DowngradeTransactionStore;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import com.mentra.recovery.util.RecoveryConstants;

/** Handles permission-guarded control broadcasts from ASG (recovery start, downgrade handoff). */
public class RecoveryControlReceiver extends BroadcastReceiver {
  /**
   * Handoff decisions run off the main thread: the controller hashes the staged APK and blocks
   * on a confirmed WorkManager enqueue, both of which would ANR a receiver. goAsync() keeps the
   * broadcast alive while the executor works.
   */
  private static final ExecutorService HANDOFF_EXECUTOR = Executors.newSingleThreadExecutor();

  @Override
  public void onReceive(Context context, Intent intent) {
    if (intent == null || intent.getAction() == null) {
      return;
    }
    switch (intent.getAction()) {
      case RecoveryConstants.ACTION_START_RECOVERY:
        Log.i(RecoveryConstants.TAG, "Starting RecoveryService from ACTION_START_RECOVERY");
        BootReceiver.startRecoveryService(context);
        break;
      case RecoveryConstants.ACTION_QUERY_DOWNGRADE_STATUS:
        // Same executor as handoffs: an idle answer cannot overtake a queued validation/enqueue.
        final PendingResult query = goAsync();
        HANDOFF_EXECUTOR.execute(() -> {
          try {
            DowngradeController.resumeIfActive(context);
            android.os.Bundle status = new DowngradeTransactionStore(context).snapshot();
            boolean installIdle = DowngradeTransactionStore.installLock().tryLock();
            if (installIdle) DowngradeTransactionStore.installLock().unlock();
            status.putBoolean("busy", !installIdle);
            status.putInt("protocol", RecoveryConstants.STATUS_PROTOCOL);
            status.putString(RecoveryConstants.EXTRA_REQUEST_ID,
                intent.getStringExtra(RecoveryConstants.EXTRA_REQUEST_ID));
            query.setResultExtras(status);
            query.setResultCode(android.app.Activity.RESULT_OK);
          } finally { query.finish(); }
        });
        break;
      case RecoveryConstants.ACTION_REQUEST_DOWNGRADE:
        String requestId = intent.getStringExtra(RecoveryConstants.EXTRA_REQUEST_ID);
        if (requestId == null) requestId = java.util.UUID.randomUUID().toString();
        final String transactionId = requestId;
        long targetVersion =
            intent.getLongExtra(RecoveryConstants.EXTRA_DOWNGRADE_TARGET_VERSION, -1L);
        String apkPath = intent.getStringExtra(RecoveryConstants.EXTRA_DOWNGRADE_APK_PATH);
        String apkSha256 = intent.getStringExtra(RecoveryConstants.EXTRA_DOWNGRADE_APK_SHA256);
        Log.i(
            RecoveryConstants.TAG,
            "Received downgrade handoff: target=" + targetVersion + ", apk=" + apkPath);
        final PendingResult pending = goAsync();
        HANDOFF_EXECUTOR.execute(
            () -> {
              try {
                DowngradeController.requestDowngrade(context, transactionId, targetVersion, apkPath, apkSha256);
              } finally {
                pending.finish();
              }
            });
        break;
      default:
        break;
    }
  }
}
