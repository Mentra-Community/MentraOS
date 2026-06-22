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
   * Signals install-in-progress (in-process + cross-app to ASG) and sends the OEM install
   * broadcast. Returns {@code true} when the broadcast was dispatched (not a confirmation of
   * install completion).
   */
  public boolean install(RemediationPolicy policy) {
    if (policy == null) {
      return false;
    }
    // Signal ASG that a remediation install is starting so its OTA pipeline defers.
    // This is the reverse of OtaHelper.notifyRecoveryInstallInProgress().
    notifyAsgRemediationInProgress(true);
    InstallPauseNotifier.notifyInstallInProgress();
    boolean dispatched =
        new SystemInstaller(context)
            .installApk(RecoveryConstants.REMEDIATION_APK_PATH, policy.packageName);
    if (!dispatched) {
      Log.e(RecoveryConstants.TAG, "Remediation install broadcast failed to dispatch");
      // Undo the pause signals immediately since no install will happen.
      notifyAsgRemediationInProgress(false);
      InstallPauseNotifier.notifyInstallCompleted();
    }
    return dispatched;
  }

  /**
   * Sends the remediation in-progress / completed signal to ASG so its OTA pipeline knows whether
   * the recovery worker is currently installing ASG.
   */
  public void notifyAsgRemediationInProgress(boolean inProgress) {
    try {
      String action =
          inProgress
              ? RecoveryConstants.ACTION_REMEDIATION_INSTALL_IN_PROGRESS
              : RecoveryConstants.ACTION_REMEDIATION_INSTALL_COMPLETED;
      Intent intent = new Intent(action);
      intent.setPackage(RecoveryConstants.ASG_PACKAGE);
      context.sendBroadcast(intent, RecoveryConstants.ASG_TELEMETRY_PERMISSION);
      Log.d(RecoveryConstants.TAG, "Notified ASG: remediation install inProgress=" + inProgress);
    } catch (Exception e) {
      Log.w(RecoveryConstants.TAG, "Failed to notify ASG of remediation install state", e);
    }
  }
}
