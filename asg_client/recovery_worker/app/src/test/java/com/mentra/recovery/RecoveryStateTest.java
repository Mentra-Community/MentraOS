package com.mentra.recovery;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import com.mentra.recovery.util.RecoveryConstants;

import org.junit.Test;

public class RecoveryStateTest {
  @Test
  public void stateNamesAreStable() {
    assertEquals("HEALTHY", RecoveryConstants.STATE_HEALTHY);
    assertEquals("FAILED_NEEDS_MANUAL", RecoveryConstants.STATE_FAILED_NEEDS_MANUAL);
  }

  @Test
  public void heartbeatIntervalsAreValid() {
    assertTrue(RecoveryConstants.HEARTBEAT_INTERVAL_MS > 0);
    assertTrue(RecoveryConstants.HEARTBEAT_FAST_INTERVAL_MS < RecoveryConstants.HEARTBEAT_INTERVAL_MS);
    assertTrue(RecoveryConstants.HEARTBEAT_TIMEOUT_MS > RecoveryConstants.HEARTBEAT_INTERVAL_MS);
    assertTrue(
        RecoveryConstants.HEARTBEAT_FAST_TIMEOUT_MS > RecoveryConstants.HEARTBEAT_FAST_INTERVAL_MS);
  }
}
