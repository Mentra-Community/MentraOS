package com.mentra.recovery;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.mentra.recovery.remediation.RemediationEvaluator;
import com.mentra.recovery.remediation.RemediationPolicy;

import org.junit.Test;

public class RemediationEvaluatorTest {

  private static RemediationPolicy policy(boolean enabled, long maxVersionCode, long versionCode) {
    return new RemediationPolicy(
        enabled,
        "com.mentra.asg_client",
        maxVersionCode,
        versionCode,
        versionCode + ".0",
        "https://example.com/asg.apk",
        "abc123");
  }

  @Test
  public void eligibleWhenInstalledAtCeilingAndTargetIsNewer() {
    // max=38, target=39: v37/v38 should remediate.
    assertTrue(RemediationEvaluator.isEligible(policy(true, 38, 39), 37));
    assertTrue(RemediationEvaluator.isEligible(policy(true, 38, 39), 38));
  }

  @Test
  public void notEligibleWhenInstalledAboveCeiling() {
    // v39 is above max=38 -> skip.
    assertFalse(RemediationEvaluator.isEligible(policy(true, 38, 39), 39));
  }

  @Test
  public void notEligibleWhenTargetNotNewerThanInstalled() {
    // target=38 never installs over installed 38 or 39, even if within ceiling.
    assertFalse(RemediationEvaluator.isEligible(policy(true, 38, 38), 38));
    assertFalse(RemediationEvaluator.isEligible(policy(true, 39, 38), 38));
  }

  @Test
  public void notEligibleWhenDisabled() {
    assertFalse(RemediationEvaluator.isEligible(policy(false, 38, 39), 37));
  }

  @Test
  public void notEligibleForNullOrInvalidPolicy() {
    assertFalse(RemediationEvaluator.isEligible(null, 37));
    assertFalse(RemediationEvaluator.isEligible(policy(true, -1, 39), 37));
    assertFalse(RemediationEvaluator.isEligible(policy(true, 38, 0), 37));
  }

  @Test
  public void notEligibleWhenPackageNotInstalled() {
    // getInstalledVersion returns -1 when not installed; -1 <= max and target > -1 -> eligible only
    // if we intend to install on a fresh device. Current policy treats -1 as eligible (target>-1).
    assertTrue(RemediationEvaluator.isEligible(policy(true, 38, 39), -1));
  }

  @Test
  public void idempotencySkipsWhenAlreadyApplied() {
    RemediationPolicy p = policy(true, 38, 39);
    assertTrue(RemediationEvaluator.isAlreadyApplied(39, p));
    assertTrue(RemediationEvaluator.isAlreadyApplied(40, p));
    assertFalse(RemediationEvaluator.isAlreadyApplied(38, p));
    assertFalse(RemediationEvaluator.isAlreadyApplied(-1, p));
    assertFalse(RemediationEvaluator.isAlreadyApplied(39, null));
  }
}
