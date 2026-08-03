package com.mentra.recovery.downgrade;

import com.mentra.recovery.util.RecoveryConstants;

import java.io.File;

/**
 * Pure file-level claim/unclaim of the staged downgrade APK. Claiming renames the staged file to
 * a transaction-owned name (atomic within the filesystem), transferring artifact ownership to the
 * transaction so a later ASG re-stage writes a different file. Kept free of Android dependencies
 * so the semantics are unit-testable on the JVM; callers do the logging.
 */
public final class ArtifactClaims {
  private ArtifactClaims() {}

  /** Renames {@code staged} to its claimed name; returns the claimed file or {@code null}. */
  public static File claim(File staged) {
    if (staged == null || !staged.isFile()) {
      return null;
    }
    File claimed =
        new File(staged.getAbsolutePath() + RecoveryConstants.DOWNGRADE_CLAIMED_APK_SUFFIX);
    if (claimed.exists() && !claimed.delete()) {
      return null;
    }
    return staged.renameTo(claimed) ? claimed : null;
  }

  /**
   * Rolls a claim back: renames {@code claimed} to its pre-claim name. Best-effort — returns
   * false when the claimed file is gone or the original name is occupied and cannot be freed.
   */
  public static boolean unclaim(File claimed) {
    if (claimed == null || !claimed.isFile()) {
      return false;
    }
    String path = claimed.getAbsolutePath();
    if (!path.endsWith(RecoveryConstants.DOWNGRADE_CLAIMED_APK_SUFFIX)) {
      return false;
    }
    File original =
        new File(
            path.substring(
                0, path.length() - RecoveryConstants.DOWNGRADE_CLAIMED_APK_SUFFIX.length()));
    if (original.exists() && !original.delete()) {
      return false;
    }
    return claimed.renameTo(original);
  }
}
