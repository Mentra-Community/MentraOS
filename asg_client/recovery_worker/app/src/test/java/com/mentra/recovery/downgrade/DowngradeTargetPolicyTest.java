package com.mentra.recovery.downgrade;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.mentra.recovery.util.RecoveryConstants;

import org.junit.Test;

public class DowngradeTargetPolicyTest {
  private static final long FLOOR = RecoveryConstants.DOWNGRADE_FLOOR_VERSION_CODE;

  @Test
  public void productionFloorStartsAtMentraThree() {
    assertEquals(51518114L, FLOOR);
  }

  @Test
  public void exactFloorIsAllowed() {
    assertTrue(DowngradeTargetPolicy.isAllowed(FLOOR, FLOOR));
  }

  @Test
  public void targetBelowFloorIsRefused() {
    assertFalse(DowngradeTargetPolicy.isAllowed(FLOOR - 1L, FLOOR));
  }

  @Test
  public void nonPositiveFloorDisablesDowngrades() {
    assertFalse(DowngradeTargetPolicy.isAllowed(FLOOR, 0L));
    assertFalse(DowngradeTargetPolicy.isAllowed(FLOOR, -1L));
  }
}
