package com.mentra.recovery;

import static org.junit.Assert.assertTrue;

import com.mentra.recovery.util.RecoveryConstants;

import org.junit.Test;

public class HealthMonitorTest {
  @Test
  public void pingPongActionsAreNamespaced() {
    assertTrue(RecoveryConstants.ACTION_PING.startsWith("com.mentra.recovery."));
    assertTrue(RecoveryConstants.ACTION_PONG.startsWith("com.mentra.recovery."));
  }
}
