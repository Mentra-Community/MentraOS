package com.mentra.asg_client.io.ota.utils;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class DowngradeGateTest {
    private static final long FLOOR = OtaConstants.DOWNGRADE_FLOOR_VERSION_CODE;

    @Test
    public void productionFloorStartsAtMentraThree() {
        assertEquals(51518114L, FLOOR);
    }

    @Test
    public void lowerPinnedVersionDowngradesWhenAboveFloor() {
        assertTrue(DowngradeGate.shouldDowngrade(51530000L, 51520000L, FLOOR));
        assertTrue(DowngradeGate.shouldDowngrade(51530000L, FLOOR, FLOOR));
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
        assertFalse(DowngradeGate.shouldDowngrade(FLOOR, FLOOR, FLOOR));
        // Higher version: that is the normal upgrade path, not a downgrade.
        assertFalse(DowngradeGate.shouldDowngrade(FLOOR, FLOOR + 1L, FLOOR));
    }

    @Test
    public void invalidManifestVersionNeverDowngrades() {
        // Zero/negative pins (e.g. the zeroed legacy rescue manifests) are never actionable.
        assertFalse(DowngradeGate.shouldDowngrade(FLOOR + 1L, 0L, FLOOR));
        assertFalse(DowngradeGate.shouldDowngrade(FLOOR + 1L, -1L, FLOOR));
    }

    @Test
    public void targetsBelowTheFloorAreRefusedEvenWhenPinned() {
        // Below the floor: predates the downgrade-safe contract (e.g. media relocation build).
        assertFalse(DowngradeGate.shouldDowngrade(51530000L, FLOOR - 1L, FLOOR));
    }
}
