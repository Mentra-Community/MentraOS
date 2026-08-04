package com.mentra.recovery.backup;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.PackageManager.NameNotFoundException;
import android.content.pm.Signature;
import android.os.Build;
import android.util.Log;

import com.mentra.recovery.util.RecoveryConstants;

import java.io.File;
import java.security.MessageDigest;
import java.util.Set;
import java.util.TreeSet;

public class BackupStore {
  private final Context context;

  public BackupStore(Context context) {
    this.context = context.getApplicationContext();
  }

  public String getBackupPath() {
    return RecoveryConstants.BACKUP_APK_PATH;
  }

  /** VersionCode of the archived backup APK, or {@code -1} when unreadable. */
  public long getBackupVersionCode() {
    try {
      PackageInfo archiveInfo =
          context.getPackageManager().getPackageArchiveInfo(getBackupPath(), 0);
      return archiveInfo == null ? -1L : getLongVersionCode(archiveInfo);
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to read backup versionCode", e);
      return -1L;
    }
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
      if (isTestOnlyArchive(backup.getAbsolutePath(), archiveInfo)) {
        Log.e(
            RecoveryConstants.TAG,
            "Backup APK is testOnly; OEM installer cannot reinstall it. Replace with a release"
                + " build at "
                + backup.getAbsolutePath());
        return false;
      }
      Set<String> archiveSigners = getSignerDigests(archiveInfo);
      if (archiveSigners.isEmpty()) {
        return false;
      }

      try {
        PackageInfo installedInfo =
            pm.getPackageInfo(RecoveryConstants.ASG_PACKAGE, PackageManager.GET_SIGNING_CERTIFICATES);
        Set<String> installedSigners = getSignerDigests(installedInfo);
        if (installedSigners.isEmpty() || !archiveSigners.equals(installedSigners)) {
          return false;
        }
        return true;
      } catch (NameNotFoundException e) {
        // ASG may be uninstalled during recovery; archive signer presence is the best check.
        Log.w(RecoveryConstants.TAG, "ASG not installed; validating backup package and signature only");
        return true;
      }
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to validate backup", e);
      return false;
    }
  }

  /**
   * True when a same-signer backup must uninstall the current build before OEM install can succeed.
   */
  public boolean requiresUninstallBeforeReinstall() {
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
      if (archiveInfo == null) {
        return false;
      }
      PackageInfo installedInfo =
          pm.getPackageInfo(RecoveryConstants.ASG_PACKAGE, PackageManager.GET_SIGNING_CERTIFICATES);
      Set<String> archiveSigners = getSignerDigests(archiveInfo);
      Set<String> installedSigners = getSignerDigests(installedInfo);
      if (archiveSigners.isEmpty()
          || installedSigners.isEmpty()
          || !archiveSigners.equals(installedSigners)) {
        return false;
      }
      long archiveVersion = getLongVersionCode(archiveInfo);
      long installedVersion = getLongVersionCode(installedInfo);
      if (archiveVersion < installedVersion) {
        Log.w(
            RecoveryConstants.TAG,
            "Backup version "
                + archiveVersion
                + " is older than installed "
                + installedVersion
                + "; will uninstall before reinstall");
        return true;
      }
      return false;
    } catch (NameNotFoundException e) {
      return false;
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to evaluate uninstall-before-reinstall", e);
      return false;
    }
  }

  private boolean isTestOnlyArchive(String apkPath, PackageInfo archiveInfo) {
    ApplicationInfo appInfo = archiveInfo.applicationInfo;
    if (appInfo == null) {
      return true;
    }
    appInfo.sourceDir = apkPath;
    appInfo.publicSourceDir = apkPath;
    return (appInfo.flags & ApplicationInfo.FLAG_TEST_ONLY) != 0;
  }

  private static long getLongVersionCode(PackageInfo info) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      return info.getLongVersionCode();
    }
    return info.versionCode;
  }

  private Set<String> getSignerDigests(PackageInfo info) {
    Set<String> digests = new TreeSet<>();
    try {
      Signature[] signers = null;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
        signers = info.signingInfo.getApkContentsSigners();
      } else if (info.signatures != null) {
        signers = info.signatures;
      }
      if (signers == null) {
        return digests;
      }
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      for (Signature signature : signers) {
        if (signature == null) {
          continue;
        }
        byte[] hash = digest.digest(signature.toByteArray());
        StringBuilder sb = new StringBuilder(hash.length * 2);
        for (byte b : hash) {
          sb.append(String.format("%02x", b));
        }
        digests.add(sb.toString());
      }
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to hash signer", e);
    }
    return digests;
  }
}
