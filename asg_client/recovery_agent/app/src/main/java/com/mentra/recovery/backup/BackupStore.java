package com.mentra.recovery.backup;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import android.util.Log;

import com.mentra.recovery.util.RecoveryConstants;

import java.io.File;
import java.security.MessageDigest;

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
      PackageInfo archiveInfo =
          pm.getPackageArchiveInfo(
              backup.getAbsolutePath(),
              PackageManager.GET_ACTIVITIES | PackageManager.GET_SIGNING_CERTIFICATES);
      if (archiveInfo == null || !RecoveryConstants.ASG_PACKAGE.equals(archiveInfo.packageName)) {
        return false;
      }
      String archiveSigner = getSignerDigest(archiveInfo);
      PackageInfo installedInfo =
          pm.getPackageInfo(RecoveryConstants.ASG_PACKAGE, PackageManager.GET_SIGNING_CERTIFICATES);
      String installedSigner = getSignerDigest(installedInfo);
      return archiveSigner != null
          && installedSigner != null
          && archiveSigner.equals(installedSigner);
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to validate backup", e);
      return false;
    }
  }

  private String getSignerDigest(PackageInfo info) {
    try {
      Signature signature = null;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
        Signature[] signers = info.signingInfo.getApkContentsSigners();
        if (signers != null && signers.length > 0) {
          signature = signers[0];
        }
      } else if (info.signatures != null && info.signatures.length > 0) {
        signature = info.signatures[0];
      }
      if (signature == null) {
        return null;
      }
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      byte[] hash = digest.digest(signature.toByteArray());
      StringBuilder sb = new StringBuilder(hash.length * 2);
      for (byte b : hash) {
        sb.append(String.format("%02x", b));
      }
      return sb.toString();
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to hash signer", e);
      return null;
    }
  }
}
