package com.mentra.recovery.remediation;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.PackageManager.NameNotFoundException;
import android.os.Build;
import android.util.Log;

import com.mentra.recovery.util.RecoveryConstants;

/**
 * Decides whether a {@link RemediationPolicy} should be applied on this device.
 *
 * <p>{@link #isEligible(RemediationPolicy, long)} is a pure function (no Android dependencies) so it
 * can be exercised by JVM unit tests. Context-bound helpers read the installed version and the
 * idempotency marker.
 */
public final class RemediationEvaluator {
  private RemediationEvaluator() {}

  /**
   * Eligible when remediation is enabled, the installed build is at or below the ceiling, and the
   * target build is strictly newer than what is installed. Same/lower target -> never install.
   */
  public static boolean isEligible(RemediationPolicy policy, long installedVersion) {
    if (policy == null || !policy.enabled) {
      return false;
    }
    if (policy.versionCode <= 0 || policy.maxVersionCode < 0) {
      return false;
    }
    if (installedVersion > policy.maxVersionCode) {
      return false;
    }
    return policy.versionCode > installedVersion;
  }

  /** Installed version code of {@code packageName}, or {@code -1} when not installed/unknown. */
  public static long getInstalledVersion(Context context, String packageName) {
    try {
      PackageManager pm = context.getPackageManager();
      PackageInfo info = pm.getPackageInfo(packageName, 0);
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        return info.getLongVersionCode();
      }
      return info.versionCode;
    } catch (NameNotFoundException e) {
      Log.d(RecoveryConstants.TAG, packageName + " not installed");
      return -1L;
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to read installed version for " + packageName, e);
      return -1L;
    }
  }

  /** True when this device already applied (or attempted past) the target version. Anti-loop guard. */
  public static boolean alreadyApplied(Context context, RemediationPolicy policy) {
    if (policy == null) {
      return false;
    }
    SharedPreferences prefs =
        context.getSharedPreferences(RecoveryConstants.REMEDIATION_PREFS, Context.MODE_PRIVATE);
    long lastApplied = prefs.getLong(RecoveryConstants.KEY_LAST_APPLIED_VERSION, -1L);
    return isAlreadyApplied(lastApplied, policy);
  }

  /** Pure idempotency comparison (no Android deps) for unit testing. */
  public static boolean isAlreadyApplied(long lastAppliedVersion, RemediationPolicy policy) {
    if (policy == null) {
      return false;
    }
    return lastAppliedVersion >= policy.versionCode;
  }

  /** Records the target version as applied so subsequent runs skip the install. */
  public static void markApplied(Context context, RemediationPolicy policy) {
    if (policy == null) {
      return;
    }
    SharedPreferences prefs =
        context.getSharedPreferences(RecoveryConstants.REMEDIATION_PREFS, Context.MODE_PRIVATE);
    prefs.edit().putLong(RecoveryConstants.KEY_LAST_APPLIED_VERSION, policy.versionCode).apply();
  }
}
