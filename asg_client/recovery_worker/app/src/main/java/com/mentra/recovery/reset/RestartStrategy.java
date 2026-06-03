package com.mentra.recovery.reset;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import com.mentra.recovery.util.RecoveryConstants;

public class RestartStrategy {
  private final Context context;

  public RestartStrategy(Context context) {
    this.context = context.getApplicationContext();
  }

  public void execute() {
    Intent restartIntent = new Intent(RecoveryConstants.ACTION_RESTART_SERVICE);
    restartIntent.setPackage(RecoveryConstants.ASG_PACKAGE);
    context.sendBroadcast(restartIntent);
    try {
      Intent serviceIntent = new Intent();
      serviceIntent.setComponent(
          new ComponentName(RecoveryConstants.ASG_PACKAGE, RecoveryConstants.ASG_SERVICE_CLASS));
      serviceIntent.setAction(RecoveryConstants.ACTION_RESTART_SERVICE);
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(serviceIntent);
      } else {
        context.startService(serviceIntent);
      }
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to start ASG service explicitly", e);
    }
  }
}
