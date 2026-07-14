package com.mentra.recovery.install;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.util.Log;
import com.mentra.recovery.util.RecoveryConstants;
import java.io.File;
import java.io.FileInputStream;
import java.security.MessageDigest;

/** Recovery-owned ASG install handoff that survives ASG preference resets and process death. */
public final class AsgInstallTransactionStore {
  private static final String PREFS = "asg_install_transaction";
  private static final String KEY_TARGET = "target_asg_version";
  private static final String KEY_SHA256 = "apk_sha256";
  private static final String KEY_DOWNGRADE = "is_downgrade";
  private static final String KEY_READY = "ready_to_install";
  private static final String KEY_STARTED_AT = "started_at_ms";
  private static final String ASG_VERSION_METADATA = "com.mentra.asg_client.ASG_VERSION";
  private static final String ASG_VERSION_PREFIX = "asg-";

  private final Context context;
  private final SharedPreferences preferences;

  public AsgInstallTransactionStore(Context context) {
    this.context = context.getApplicationContext();
    preferences = this.context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  public boolean begin(long targetAsgVersion, String sha256, boolean downgrade) {
    if (targetAsgVersion <= 0) {
      throw new IllegalArgumentException("targetAsgVersion must be positive");
    }
    return preferences
        .edit()
        .putLong(KEY_TARGET, targetAsgVersion)
        .putString(KEY_SHA256, sha256 == null ? "" : sha256)
        .putBoolean(KEY_DOWNGRADE, downgrade)
        .putBoolean(KEY_READY, !downgrade)
        .putLong(KEY_STARTED_AT, System.currentTimeMillis())
        .commit();
  }

  public boolean hasPending() {
    return targetAsgVersion() > 0;
  }

  public long targetAsgVersion() {
    return preferences.getLong(KEY_TARGET, -1L);
  }

  /** A downgrade is armed only after ASG confirms its mandatory state reset completed. */
  public boolean markReady(long targetAsgVersion) {
    if (targetAsgVersion <= 0 || targetAsgVersion != targetAsgVersion()) {
      return false;
    }
    return preferences.edit().putBoolean(KEY_READY, true).commit();
  }

  public boolean isReadyToInstall() {
    return hasPending() && preferences.getBoolean(KEY_READY, false);
  }

  /** True only for the checksum-verified ASG APK that declares this pending logical target. */
  public boolean pendingArtifactMatches(File apk) {
    if (apk == null || !apk.exists() || !apk.canRead() || apk.length() <= 0) {
      return false;
    }
    String expectedSha = preferences.getString(KEY_SHA256, "");
    if (!expectedSha.matches("(?i)[0-9a-f]{64}")) {
      Log.e(RecoveryConstants.TAG, "Pending ASG install has no valid APK checksum");
      return false;
    }
    try {
      if (!expectedSha.equalsIgnoreCase(sha256(apk))) {
        Log.e(RecoveryConstants.TAG, "Pending ASG install APK checksum does not match");
        return false;
      }
      PackageInfo archive =
          context
              .getPackageManager()
              .getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.GET_META_DATA);
      return archive != null
          && RecoveryConstants.ASG_PACKAGE.equals(archive.packageName)
          && readAsgVersion(archive) == targetAsgVersion();
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Could not validate pending ASG install APK", e);
      return false;
    }
  }

  /** Clears the handoff only after PackageManager reports the exact logical target. */
  public boolean reconcileInstalledVersion() {
    long target = targetAsgVersion();
    if (target <= 0) {
      return false;
    }
    long installed = readInstalledAsgVersion(context.getPackageManager());
    if (installed != target) {
      Log.w(
          RecoveryConstants.TAG,
          "ASG install remains pending: installed=" + installed + ", target=" + target);
      return false;
    }
    preferences.edit().clear().commit();
    Log.i(RecoveryConstants.TAG, "Confirmed exact ASG install target " + target);
    return true;
  }

  public static long readInstalledAsgVersion(PackageManager packageManager) {
    try {
      PackageInfo info =
          packageManager.getPackageInfo(
              RecoveryConstants.ASG_PACKAGE, PackageManager.GET_META_DATA);
      return readAsgVersion(info);
    } catch (Exception e) {
      Log.w(RecoveryConstants.TAG, "Could not read installed ASG logical version", e);
      return -1L;
    }
  }

  private static long readAsgVersion(PackageInfo info) {
    Bundle metadata = info.applicationInfo != null ? info.applicationInfo.metaData : null;
    if (metadata != null) {
      long parsed = parseMetadata(metadata.get(ASG_VERSION_METADATA));
      if (parsed > 0) {
        return parsed;
      }
    }
    return info.getLongVersionCode();
  }

  static String sha256(File file) throws Exception {
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    try (FileInputStream input = new FileInputStream(file)) {
      byte[] buffer = new byte[64 * 1024];
      int read;
      while ((read = input.read(buffer)) != -1) {
        digest.update(buffer, 0, read);
      }
    }
    StringBuilder hex = new StringBuilder(64);
    for (byte value : digest.digest()) {
      hex.append(String.format("%02x", value));
    }
    return hex.toString();
  }

  static long parseMetadata(Object value) {
    if (value instanceof Number) {
      return ((Number) value).longValue();
    }
    if (!(value instanceof String)) {
      return -1L;
    }
    String raw = ((String) value).trim();
    if (raw.startsWith(ASG_VERSION_PREFIX)) {
      raw = raw.substring(ASG_VERSION_PREFIX.length());
    }
    try {
      long parsed = Long.parseLong(raw);
      return parsed > 0 ? parsed : -1L;
    } catch (NumberFormatException ignored) {
      return -1L;
    }
  }
}
