package com.mentra.recovery.service;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Log;

import com.mentra.recovery.util.RecoveryConstants;

/** Fail-closed cleanup for a vendor AP explicitly owned by an ASG OTA package replacement. */
public final class HotspotOtaFailsafe {
  private static final String PREFS = "hotspot_ota_failsafe";
  private static final String KEY_OWNED_RESTART = "owned_restart";
  private static final String SYSTEM_UI_PACKAGE = "com.android.systemui";
  private static final String SYSTEM_UI_ACTION = "com.xy.xsetting.action";

  private final Context context;
  private final SharedPreferences prefs;

  public HotspotOtaFailsafe(Context context) {
    this.context = context.getApplicationContext();
    this.prefs = this.context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  public void setOwnedRestart(boolean owned) {
    prefs.edit().putBoolean(KEY_OWNED_RESTART, owned).commit();
  }

  public void clear() {
    prefs.edit().remove(KEY_OWNED_RESTART).apply();
  }

  public boolean isOwnedRestart() {
    return prefs.getBoolean(KEY_OWNED_RESTART, false);
  }

  /** Called only after RecoveryWorker has proved restart and late-PONG recovery both failed. */
  public boolean stopOrphanedVendorApIfOwned() {
    if (!isOwnedRestart()) {
      return false;
    }
    Intent intent = new Intent(SYSTEM_UI_ACTION);
    intent.setPackage(SYSTEM_UI_PACKAGE);
    intent.putExtra("cmd", "ap_start");
    intent.putExtra("enable", false);
    context.sendBroadcast(intent);
    clear();
    Log.w(RecoveryConstants.TAG, "Stopped orphaned hotspot after failed ASG OTA recovery");
    return true;
  }
}
