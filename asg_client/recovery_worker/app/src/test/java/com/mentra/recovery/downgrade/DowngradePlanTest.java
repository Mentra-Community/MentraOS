package com.mentra.recovery.downgrade;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class DowngradePlanTest {
  private static final int MAX_ATTEMPTS = 3;

  @Test
  public void isDowngradeRequiresValidLowerTarget() {
    assertTrue(DowngradePlan.isDowngrade(49076573L, 49000000L));
    assertFalse(DowngradePlan.isDowngrade(49000000L, 49076573L));
    assertFalse(DowngradePlan.isDowngrade(49000000L, 49000000L));
    assertFalse(DowngradePlan.isDowngrade(49000000L, 0L));
    assertFalse(DowngradePlan.isDowngrade(49000000L, -1L));
  }

  @Test
  public void convergedTransactionCompletes() {
    assertEquals(
        DowngradePlan.Action.ALREADY_AT_TARGET,
        DowngradePlan.nextAction(49000000L, 49000000L, true, 1, MAX_ATTEMPTS));
    // Also terminal when convergence is observed before any step ran (e.g. duplicate handoff).
    assertEquals(
        DowngradePlan.Action.ALREADY_AT_TARGET,
        DowngradePlan.nextAction(49000000L, 49000000L, false, 0, MAX_ATTEMPTS));
  }

  @Test
  public void aboveTargetUninstallsOnceThenWaits() {
    assertEquals(
        DowngradePlan.Action.SEND_UNINSTALL,
        DowngradePlan.nextAction(49076573L, 49000000L, false, 0, MAX_ATTEMPTS));
    assertEquals(
        DowngradePlan.Action.WAIT_FOR_REVERT,
        DowngradePlan.nextAction(49076573L, 49000000L, true, 0, MAX_ATTEMPTS));
  }

  @Test
  public void belowTargetInstallsUntilAttemptsExhausted() {
    // Factory floor after the revert.
    assertEquals(
        DowngradePlan.Action.SEND_INSTALL,
        DowngradePlan.nextAction(39L, 49000000L, true, 0, MAX_ATTEMPTS));
    assertEquals(
        DowngradePlan.Action.SEND_INSTALL,
        DowngradePlan.nextAction(39L, 49000000L, true, MAX_ATTEMPTS - 1, MAX_ATTEMPTS));
    assertEquals(
        DowngradePlan.Action.GIVE_UP,
        DowngradePlan.nextAction(39L, 49000000L, true, MAX_ATTEMPTS, MAX_ATTEMPTS));
  }

  @Test
  public void missingPackageStillInstalls() {
    // Unresolvable package reads as -1; installing the staged APK is the only way forward.
    assertEquals(
        DowngradePlan.Action.SEND_INSTALL,
        DowngradePlan.nextAction(-1L, 49000000L, true, 0, MAX_ATTEMPTS));
  }

  @Test
  public void rebootDuringRevertResumesCorrectly() {
    // After a mid-transaction reboot the worker re-derives its step from package state alone:
    // still above target -> keep waiting; at floor -> install.
    assertEquals(
        DowngradePlan.Action.WAIT_FOR_REVERT,
        DowngradePlan.nextAction(49076573L, 49000000L, true, 0, MAX_ATTEMPTS));
    assertEquals(
        DowngradePlan.Action.SEND_INSTALL,
        DowngradePlan.nextAction(39L, 49000000L, true, 1, MAX_ATTEMPTS));
  }
}
