package com.mentra.recovery.service;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.mentra.recovery.downgrade.DowngradeController;

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
      case RecoveryConstants.ACTION_REQUEST_DOWNGRADE:
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
                DowngradeController.requestDowngrade(context, targetVersion, apkPath, apkSha256);
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
