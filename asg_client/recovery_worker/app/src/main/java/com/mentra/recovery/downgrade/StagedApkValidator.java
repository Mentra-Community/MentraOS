package com.mentra.recovery.downgrade;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import android.util.Log;

import com.mentra.recovery.util.RecoveryConstants;

import java.io.File;
import java.io.FileInputStream;
import java.security.MessageDigest;
import java.util.Set;
import java.util.TreeSet;

/**
 * Full validation of a staged downgrade APK, shared by the handoff decision and the worker.
 *
 * <p>Run BEFORE a handoff is accepted: "accepted" is a promise of ownership to ASG and the
 * phone, so everything that can be known to fail must fail before the verdict, not after it —
 * a post-acceptance give-up strands ASG on the long supervision timer with no transaction.
 * The worker re-runs the same validation post-revert as defense in depth.
 *
 * <p>The byte-level stage ({@link #validateBytes}) is Android-free and unit-tested on the JVM;
 * the archive stage needs {@link PackageManager}. Both return {@code null} when valid, else a
 * short machine-readable reason (callers log).
 */
public final class StagedApkValidator {
  private StagedApkValidator() {}

  /** Byte-level stage: presence, readability, size, sha256. Null when valid. */
  public static String validateBytes(File apk, String expectedSha256) {
    if (apk == null || !apk.isFile() || !apk.canRead() || apk.length() <= 0) {
      return "missing_or_unreadable";
    }
    if (expectedSha256 != null && !expectedSha256.isEmpty()) {
      String actual = sha256Of(apk);
      if (actual == null || !expectedSha256.equalsIgnoreCase(actual)) {
        return "sha256_mismatch";
      }
    }
    return null;
  }

  /** Archive stage: ASG package, exact target versionCode, not testOnly, signer match. */
  public static String validateArchive(Context context, File apk, long targetVersion) {
    try {
      PackageManager pm = context.getPackageManager();
      PackageInfo archive =
          pm.getPackageArchiveInfo(
              apk.getAbsolutePath(),
              PackageManager.GET_ACTIVITIES | PackageManager.GET_SIGNING_CERTIFICATES);
      if (archive == null || !RecoveryConstants.ASG_PACKAGE.equals(archive.packageName)) {
        return "not_asg_package";
      }
      long archiveVersion =
          Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
              ? archive.getLongVersionCode()
              : archive.versionCode;
      if (archiveVersion != targetVersion) {
        return "version_mismatch";
      }
      ApplicationInfo appInfo = archive.applicationInfo;
      if (appInfo == null) {
        return "unreadable_archive";
      }
      appInfo.sourceDir = apk.getAbsolutePath();
      appInfo.publicSourceDir = apk.getAbsolutePath();
      if ((appInfo.flags & ApplicationInfo.FLAG_TEST_ONLY) != 0) {
        return "test_only";
      }
      Set<String> archiveSigners = signerDigests(archive);
      if (archiveSigners.isEmpty()) {
        return "unsigned";
      }
      try {
        PackageInfo installedInfo =
            pm.getPackageInfo(
                RecoveryConstants.ASG_PACKAGE, PackageManager.GET_SIGNING_CERTIFICATES);
        Set<String> installedSigners = signerDigests(installedInfo);
        if (!installedSigners.isEmpty() && !archiveSigners.equals(installedSigners)) {
          return "signer_mismatch";
        }
      } catch (PackageManager.NameNotFoundException e) {
        Log.w(RecoveryConstants.TAG, "ASG not installed; validating archive signature only");
      }
      return null;
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to validate staged downgrade APK", e);
      return "validation_error";
    }
  }

  /** Both stages. Null when valid, else the first failing reason. */
  public static String validate(Context context, String apkPath, String sha256, long targetVersion) {
    File apk = apkPath == null ? null : new File(apkPath);
    String bytes = validateBytes(apk, sha256);
    if (bytes != null) {
      return bytes;
    }
    return validateArchive(context, apk, targetVersion);
  }

  /** Lowercase hex sha256 of the file, or {@code null} on any error. Android-free. */
  static String sha256Of(File file) {
    try (FileInputStream in = new FileInputStream(file)) {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      byte[] buffer = new byte[8192];
      int read;
      while ((read = in.read(buffer)) != -1) {
        digest.update(buffer, 0, read);
      }
      StringBuilder sb = new StringBuilder();
      for (byte b : digest.digest()) {
        sb.append(String.format("%02x", b));
      }
      return sb.toString();
    } catch (Exception e) {
      return null;
    }
  }

  private static Set<String> signerDigests(PackageInfo info) {
    Set<String> digests = new TreeSet<>();
    try {
      Signature[] signers = null;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
        signers = info.signingInfo.getApkContentsSigners();
      }
      if (signers == null) {
        signers = info.signatures;
      }
      if (signers == null) {
        return digests;
      }
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      for (Signature signer : signers) {
        byte[] hash = digest.digest(signer.toByteArray());
        StringBuilder sb = new StringBuilder();
        for (byte b : hash) {
          sb.append(String.format("%02x", b));
        }
        digests.add(sb.toString());
      }
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to compute signer digests", e);
    }
    return digests;
  }
}
