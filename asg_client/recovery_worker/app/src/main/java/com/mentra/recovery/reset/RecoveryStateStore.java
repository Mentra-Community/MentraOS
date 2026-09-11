package com.mentra.recovery.reset;

import android.content.Context;
import android.content.SharedPreferences;

import com.mentra.recovery.util.RecoveryConstants;

public class RecoveryStateStore {
  private final SharedPreferences prefs;

  public RecoveryStateStore(Context context) {
    prefs = context.getSharedPreferences(RecoveryConstants.STATE_PREFS, Context.MODE_PRIVATE);
  }

  public String getState() {
    return prefs.getString(RecoveryConstants.KEY_STATE, RecoveryConstants.STATE_HEALTHY);
  }

  public void setState(String state, String reason) {
    prefs
        .edit()
        .putString(RecoveryConstants.KEY_STATE, state)
        .putString(RecoveryConstants.KEY_REASON, reason)
        .putLong(RecoveryConstants.KEY_LAST_TRANSITION_MS, System.currentTimeMillis())
        .apply();
  }

  public int getAttempts() {
    return prefs.getInt(RecoveryConstants.KEY_ATTEMPTS, 0);
  }

  public void setAttempts(int attempts) {
    prefs.edit().putInt(RecoveryConstants.KEY_ATTEMPTS, attempts).apply();
  }

  public long getWindowStartMs() {
    return prefs.getLong(RecoveryConstants.KEY_WINDOW_START_MS, 0L);
  }

  public void setWindowStartMs(long value) {
    prefs.edit().putLong(RecoveryConstants.KEY_WINDOW_START_MS, value).apply();
  }

  public long getLastTransitionMs() {
    return prefs.getLong(RecoveryConstants.KEY_LAST_TRANSITION_MS, 0L);
  }
}
