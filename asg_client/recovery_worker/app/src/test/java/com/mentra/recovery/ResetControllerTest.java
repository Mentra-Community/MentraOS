package com.mentra.recovery;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import com.mentra.recovery.util.RecoveryConstants;

import org.junit.Test;

public class ResetControllerTest {
  @Test
  public void recoveryWindowIsReasonable() {
    assertEquals(30 * 60 * 1000L, RecoveryConstants.RECOVERY_WINDOW_MS);
    assertTrue(RecoveryConstants.MAX_RECOVERIES_PER_WINDOW >= 1);
  }
}
