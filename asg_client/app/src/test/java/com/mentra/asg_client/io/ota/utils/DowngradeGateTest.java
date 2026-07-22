package com.mentra.asg_client.io.ota.utils;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class DowngradeGateTest {
    private static final long NO_FLOOR = 0L;

    @Test
    public void downgradeRequiresExplicitOptIn() {
        // Lower pinned version without the opt-in (the fleet-manifest case) must never downgrade.
        assertFalse(DowngradeGate.shouldDowngrade(49076573L, 49000000L, false, NO_FLOOR));
        assertTrue(DowngradeGate.shouldDowngrade(49076573L, 49000000L, true, NO_FLOOR));
    }

    @Test
    public void optInAloneDoesNotForceReinstallOrUpgrade() {
        // Equal version: exact pin already satisfied, nothing to do.
        assertFalse(DowngradeGate.shouldDowngrade(49000000L, 49000000L, true, NO_FLOOR));
        // Higher version: that is the normal upgrade path, not a downgrade.
        assertFalse(DowngradeGate.shouldDowngrade(49000000L, 49076573L, true, NO_FLOOR));
    }

    @Test
    public void invalidManifestVersionNeverDowngrades() {
        assertFalse(DowngradeGate.shouldDowngrade(49076573L, 0L, true, NO_FLOOR));
        assertFalse(DowngradeGate.shouldDowngrade(49076573L, -1L, true, NO_FLOOR));
    }

    @Test
    public void targetsBelowTheFloorAreRefusedEvenWhenPinned() {
        long floor = 49000000L;
        // Below the floor: predates the downgrade-safe contract (e.g. media relocation build).
        assertFalse(DowngradeGate.shouldDowngrade(49076573L, 48999999L, true, floor));
        // At or above the floor: supported.
        assertTrue(DowngradeGate.shouldDowngrade(49076573L, 49000000L, true, floor));
        assertTrue(DowngradeGate.shouldDowngrade(49076573L, 49066528L, true, floor));
    }
}
