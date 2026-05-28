package com.mentra.recovery.backup;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.util.Log;

import com.mentra.recovery.util.RecoveryConstants;

import java.io.File;

public class BackupStore {
  private final Context context;

  public BackupStore(Context context) {
    this.context = context.getApplicationContext();
  }

  public String getBackupPath() {
    return RecoveryConstants.BACKUP_APK_PATH;
  }

  public boolean isValidBackup() {
    File backup = new File(getBackupPath());
    if (!backup.exists() || !backup.canRead() || backup.length() <= 0) {
      return false;
    }
    try {
      PackageManager pm = context.getPackageManager();
      PackageInfo info = pm.getPackageArchiveInfo(backup.getAbsolutePath(), PackageManager.GET_ACTIVITIES);
      return info != null && RecoveryConstants.ASG_PACKAGE.equals(info.packageName);
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to validate backup", e);
      return false;
    }
  }
}
