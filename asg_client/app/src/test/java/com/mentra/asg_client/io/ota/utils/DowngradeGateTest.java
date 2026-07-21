package com.mentra.asg_client.io.ota.utils;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class DowngradeGateTest {

    @Test
    public void downgradeRequiresExplicitOptIn() {
        // Lower pinned version without the opt-in (the fleet-manifest case) must never downgrade.
        assertFalse(DowngradeGate.shouldDowngrade(49076573L, 49000000L, false));
        assertTrue(DowngradeGate.shouldDowngrade(49076573L, 49000000L, true));
    }

    @Test
    public void optInAloneDoesNotForceReinstallOrUpgrade() {
        // Equal version: exact pin already satisfied, nothing to do.
        assertFalse(DowngradeGate.shouldDowngrade(49000000L, 49000000L, true));
        // Higher version: that is the normal upgrade path, not a downgrade.
        assertFalse(DowngradeGate.shouldDowngrade(49000000L, 49076573L, true));
    }

    @Test
    public void invalidManifestVersionNeverDowngrades() {
        assertFalse(DowngradeGate.shouldDowngrade(49076573L, 0L, true));
        assertFalse(DowngradeGate.shouldDowngrade(49076573L, -1L, true));
    }
}
