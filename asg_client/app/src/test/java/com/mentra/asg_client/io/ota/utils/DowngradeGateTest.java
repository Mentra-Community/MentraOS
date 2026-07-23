package com.mentra.asg_client.io.ota.utils;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class DowngradeGateTest {
    private static final long NO_FLOOR = 0L;

    @Test
    public void lowerPinnedVersionDowngrades() {
        assertTrue(DowngradeGate.shouldDowngrade(49076573L, 49000000L, NO_FLOOR));
    }

    @Test
    public void exactOrNewerPinDoesNotDowngrade() {
        // Equal version: exact pin already satisfied, nothing to do.
        assertFalse(DowngradeGate.shouldDowngrade(49000000L, 49000000L, NO_FLOOR));
        // Higher version: that is the normal upgrade path, not a downgrade.
        assertFalse(DowngradeGate.shouldDowngrade(49000000L, 49076573L, NO_FLOOR));
    }

    @Test
    public void invalidManifestVersionNeverDowngrades() {
        // Zero/negative pins (e.g. the zeroed legacy rescue manifests) are never actionable.
        assertFalse(DowngradeGate.shouldDowngrade(49076573L, 0L, NO_FLOOR));
        assertFalse(DowngradeGate.shouldDowngrade(49076573L, -1L, NO_FLOOR));
    }

    @Test
    public void targetsBelowTheFloorAreRefusedEvenWhenPinned() {
        long floor = 49000000L;
        // Below the floor: predates the downgrade-safe contract (e.g. media relocation build).
        assertFalse(DowngradeGate.shouldDowngrade(49076573L, 48999999L, floor));
        // At or above the floor: supported.
        assertTrue(DowngradeGate.shouldDowngrade(49076573L, 49000000L, floor));
        assertTrue(DowngradeGate.shouldDowngrade(49076573L, 49066528L, floor));
    }
}
