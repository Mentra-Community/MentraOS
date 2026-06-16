package com.mentra.recovery.service;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.mentra.recovery.util.RecoveryConstants;

/** Starts {@link RecoveryService} when ASG requests recovery via a permission-guarded broadcast. */
public class RecoveryControlReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    if (intent == null || !RecoveryConstants.ACTION_START_RECOVERY.equals(intent.getAction())) {
      return;
    }
    Log.i(RecoveryConstants.TAG, "Starting RecoveryService from ACTION_START_RECOVERY");
    BootReceiver.startRecoveryService(context);
  }
}
