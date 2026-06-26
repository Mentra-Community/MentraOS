package com.mentra.recovery.remediation;

import androidx.annotation.NonNull;

import com.mentra.recovery.util.RecoveryConstants;

import org.json.JSONObject;

/**
 * Immutable view of the {@code remediation} block from the OTA manifest.
 *
 * <p>Drives a self-contained ASG force-install path that bypasses ASG's own OTA cache: the recovery
 * worker always downloads a fresh APK when the installed build is at or below {@link #maxVersionCode}
 * and strictly older than {@link #versionCode}.
 */
public final class RemediationPolicy {
  public final boolean enabled;
  public final String packageName;
  public final long maxVersionCode;
  public final long versionCode;
  public final String versionName;
  public final String apkUrl;
  public final String sha256;

  public RemediationPolicy(
      boolean enabled,
      String packageName,
      long maxVersionCode,
      long versionCode,
      String versionName,
      String apkUrl,
      String sha256) {
    this.enabled = enabled;
    this.packageName = packageName;
    this.maxVersionCode = maxVersionCode;
    this.versionCode = versionCode;
    this.versionName = versionName;
    this.apkUrl = apkUrl;
    this.sha256 = sha256;
  }

  /**
   * Parses a {@code remediation} JSON object. Returns {@code null} when the object is missing
   * required install fields (apkUrl / sha256), so callers treat malformed entries as a no-op.
   */
  public static RemediationPolicy fromJson(JSONObject json) {
    if (json == null) {
      return null;
    }
    String apkUrl = json.optString("apkUrl", "");
    String sha256 = json.optString("sha256", "");
    if (apkUrl.isEmpty() || sha256.isEmpty()) {
      return null;
    }
    boolean enabled = json.optBoolean("enabled", false);
    String packageName = json.optString("packageName", RecoveryConstants.ASG_PACKAGE);
    long maxVersionCode = json.optLong("maxVersionCode", -1L);
    long versionCode = json.optLong("versionCode", -1L);
    String versionName = json.optString("versionName", "");
    return new RemediationPolicy(
        enabled, packageName, maxVersionCode, versionCode, versionName, apkUrl, sha256);
  }

  @NonNull
  @Override
  public String toString() {
    return "RemediationPolicy{enabled="
        + enabled
        + ", packageName="
        + packageName
        + ", maxVersionCode="
        + maxVersionCode
        + ", versionCode="
        + versionCode
        + ", versionName="
        + versionName
        + "}";
  }
}
