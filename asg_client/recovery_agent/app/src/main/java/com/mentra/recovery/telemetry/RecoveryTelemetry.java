package com.mentra.recovery.telemetry;

import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.mentra.recovery.util.RecoveryConstants;

public class RecoveryTelemetry {
  private final Context context;

  public RecoveryTelemetry(Context context) {
    this.context = context.getApplicationContext();
  }

  public void emit(String event, String state, String reason, int attempt, boolean success) {
    Log.i(RecoveryConstants.TAG, "event=" + event + " state=" + state + " reason=" + reason + " attempt=" + attempt);
    Intent intent = new Intent(RecoveryConstants.ACTION_TELEMETRY);
    intent.setPackage(RecoveryConstants.ASG_PACKAGE);
    intent.putExtra("event", event);
    intent.putExtra("state", state);
    intent.putExtra("reason", reason);
    intent.putExtra("attempt", attempt);
    intent.putExtra("success", success);
    context.sendBroadcast(intent, RecoveryConstants.ASG_TELEMETRY_PERMISSION);
  }
}
