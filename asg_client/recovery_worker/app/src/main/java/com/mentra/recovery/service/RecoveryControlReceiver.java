package com.mentra.recovery.service;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.mentra.recovery.downgrade.DowngradeController;
import com.mentra.recovery.util.RecoveryConstants;

/** Handles permission-guarded control broadcasts from ASG (recovery start, downgrade handoff). */
public class RecoveryControlReceiver extends BroadcastReceiver {
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
        DowngradeController.requestDowngrade(context, targetVersion, apkPath, apkSha256);
        break;
      default:
        break;
    }
  }
}
