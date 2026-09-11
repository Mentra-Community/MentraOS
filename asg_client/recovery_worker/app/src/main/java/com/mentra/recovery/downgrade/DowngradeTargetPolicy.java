package com.mentra.recovery.downgrade;

/** Applies the recovery worker's independent downgrade target floor. */
final class DowngradeTargetPolicy {
  private DowngradeTargetPolicy() {}

  static boolean isAllowed(long targetVersion, long floorVersion) {
    return floorVersion > 0 && targetVersion >= floorVersion;
  }
}
