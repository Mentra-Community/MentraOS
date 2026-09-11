package com.mentra.recovery.service;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import com.mentra.recovery.util.RecoveryConstants;

public class BootReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    if (intent == null || intent.getAction() == null) {
      return;
    }
    String action = intent.getAction();
    if (!Intent.ACTION_BOOT_COMPLETED.equals(action)) {
      return;
    }
    Log.i(RecoveryConstants.TAG, "Starting RecoveryService from BOOT_COMPLETED");
    startRecoveryService(context);
  }

  static void startRecoveryService(Context context) {
    Intent serviceIntent = new Intent(context, RecoveryService.class);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      context.startForegroundService(serviceIntent);
    } else {
      context.startService(serviceIntent);
    }
  }
}
