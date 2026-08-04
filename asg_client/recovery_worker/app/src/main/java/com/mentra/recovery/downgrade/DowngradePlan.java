package com.mentra.recovery.downgrade;

/**
 * Pure decision logic for the pinned-downgrade detour.
 *
 * <p>The OEM SystemUI installer refuses lower-versionCode installs and never sets
 * INSTALL_ALLOW_DOWNGRADE, but "uninstalling" the ASG system app reverts it to the factory
 * {@code /system} build, whose versionCode is below every published release. From that floor the
 * staged target APK is an ordinary upgrade. This class decides the next step from observable
 * package state only, so the transaction can resume after process death or reboot at any point.
 */
public final class DowngradePlan {
  public enum Action {
    /** Installed version equals the target; the transaction is complete. */
    ALREADY_AT_TARGET,
    /** Installed version is above the target and no uninstall was sent yet. */
    SEND_UNINSTALL,
    /** Uninstall was sent; keep waiting for the factory revert to be observed. */
    WAIT_FOR_REVERT,
    /** Installed version is below the target (factory floor); install the staged APK. */
    SEND_INSTALL,
    /** Install attempts are exhausted. */
    GIVE_UP,
  }

  private DowngradePlan() {}

  /** True when {@code targetVersion} is a valid pin logically below the installed build. */
  public static boolean isDowngrade(long installedVersion, long targetVersion) {
    return targetVersion > 0 && installedVersion > targetVersion;
  }

  /**
   * Next step for a persisted transaction, derived from the currently installed versionCode.
   *
   * @param installedVersion installed ASG versionCode, or a negative value when unresolvable
   * @param targetVersion pinned target versionCode (always positive for a valid transaction)
   * @param uninstallRequested whether this transaction already dispatched the uninstall broadcast
   * @param installAttempts install broadcasts already dispatched by this transaction
   * @param maxInstallAttempts give-up threshold for install dispatches
   */
  public static Action nextAction(
      long installedVersion,
      long targetVersion,
      boolean uninstallRequested,
      int installAttempts,
      int maxInstallAttempts) {
    if (installedVersion == targetVersion) {
      return Action.ALREADY_AT_TARGET;
    }
    if (installedVersion > targetVersion) {
      return uninstallRequested ? Action.WAIT_FOR_REVERT : Action.SEND_UNINSTALL;
    }
    // Below target: either the factory floor after the revert, or ASG missing entirely.
    return installAttempts < maxInstallAttempts ? Action.SEND_INSTALL : Action.GIVE_UP;
  }
}
