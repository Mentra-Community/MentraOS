package com.mentra.recovery.remediation;

import android.content.Context;
import android.util.Log;

import com.mentra.recovery.health.InstallPauseNotifier;
import com.mentra.recovery.util.RecoveryConstants;
import com.mentra.recovery.util.SystemInstaller;

/**
 * Performs the OEM force-install of a downloaded remediation APK, pausing heartbeat monitoring for
 * the duration so the install/reboot window is not mistaken for an ASG crash.
 */
public class RemediationInstaller {
  private final Context context;

  public RemediationInstaller(Context context) {
    this.context = context.getApplicationContext();
  }

  /**
   * Signals install-in-progress and sends the OEM install broadcast. Returns {@code true} when the
   * broadcast was dispatched (not a confirmation of install completion).
   */
  public boolean install(RemediationPolicy policy) {
    if (policy == null) {
      return false;
    }
    InstallPauseNotifier.notifyInstallInProgress();
    boolean dispatched =
        new SystemInstaller(context)
            .installApk(RecoveryConstants.REMEDIATION_APK_PATH, policy.packageName);
    if (!dispatched) {
      Log.e(RecoveryConstants.TAG, "Remediation install broadcast failed to dispatch");
      InstallPauseNotifier.notifyInstallCompleted();
    }
    return dispatched;
  }
}
