package com.mentra.recovery.reset;

import android.content.Context;

import com.mentra.recovery.backup.BackupStore;
import com.mentra.recovery.util.RecoveryConstants;
import com.mentra.recovery.util.SystemInstaller;

public class ReinstallStrategy {
  private final BackupStore backupStore;
  private final SystemInstaller installer;

  public ReinstallStrategy(Context context) {
    backupStore = new BackupStore(context);
    installer = new SystemInstaller(context);
  }

  public boolean execute() {
    if (!backupStore.isValidBackup()) {
      return false;
    }
    if (backupStore.requiresUninstallBeforeReinstall()) {
      installer.uninstallPackage(RecoveryConstants.ASG_PACKAGE);
      try {
        Thread.sleep(5000L);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        return false;
      }
    }
    return installer.installApk(backupStore.getBackupPath(), RecoveryConstants.ASG_PACKAGE);
  }
}
