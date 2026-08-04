package com.mentra.asg_client.io.ota.utils;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class DowngradeGateTest {
    private static final long FLOOR = 49000000L;

    @Test
    public void lowerPinnedVersionDowngradesWhenAboveFloor() {
        assertTrue(DowngradeGate.shouldDowngrade(49076573L, 49066528L, FLOOR));
        assertTrue(DowngradeGate.shouldDowngrade(49076573L, 49000000L, FLOOR));
    }

    @Test
    public void nonPositiveFloorDisablesDowngradesEntirely() {
        // Fail closed: floor 0 (the bench/unset configuration) must never allow a downgrade,
        // even for an otherwise-valid lower pin.
        assertFalse(DowngradeGate.shouldDowngrade(49076573L, 49000000L, 0L));
        assertFalse(DowngradeGate.shouldDowngrade(49076573L, 49000000L, -1L));
    }

    @Test
    public void exactOrNewerPinDoesNotDowngrade() {
        // Equal version: exact pin already satisfied, nothing to do.
        assertFalse(DowngradeGate.shouldDowngrade(49000000L, 49000000L, FLOOR));
        // Higher version: that is the normal upgrade path, not a downgrade.
        assertFalse(DowngradeGate.shouldDowngrade(49000000L, 49076573L, FLOOR));
    }

    @Test
    public void invalidManifestVersionNeverDowngrades() {
        // Zero/negative pins (e.g. the zeroed legacy rescue manifests) are never actionable.
        assertFalse(DowngradeGate.shouldDowngrade(49076573L, 0L, FLOOR));
        assertFalse(DowngradeGate.shouldDowngrade(49076573L, -1L, FLOOR));
    }

    @Test
    public void targetsBelowTheFloorAreRefusedEvenWhenPinned() {
        // Below the floor: predates the downgrade-safe contract (e.g. media relocation build).
        assertFalse(DowngradeGate.shouldDowngrade(49076573L, 48999999L, FLOOR));
    }
}
