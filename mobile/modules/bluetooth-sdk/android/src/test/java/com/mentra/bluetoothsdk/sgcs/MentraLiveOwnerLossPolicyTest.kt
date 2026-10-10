package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothDevice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MentraLiveOwnerLossPolicyTest {
    @Test
    fun connectTimeRejectionIsOwnerLossOnlyOutsideExplicitPairing() {
        assertTrue(MentraLiveOwnerLossPolicy.shouldStandDownOnGattError(5, manualPairing = false))
        assertTrue(MentraLiveOwnerLossPolicy.shouldStandDownOnGattError(15, manualPairing = false))
        assertFalse(MentraLiveOwnerLossPolicy.shouldStandDownOnGattError(5, manualPairing = true))
    }

    @Test
    fun rfDropsAndRemoteTerminationAreNotOwnerLoss() {
        for (status in listOf(8, 19, 22, 62, 133)) {
            assertFalse(
                    "status $status",
                    MentraLiveOwnerLossPolicy.shouldStandDownOnGattError(status, manualPairing = false),
            )
        }
    }

    @Test
    fun bondDroppedRightAfterAutomaticReconnectIsOwnerLoss() {
        assertTrue(bondRemoved(msSinceAutoReconnectLink = 600L))
    }

    @Test
    fun bondRemovalOutsideAReconnectIsNotOwnerLoss() {
        assertFalse(bondRemoved(msSinceAutoReconnectLink = null))
        assertFalse(bondRemoved(msSinceAutoReconnectLink = 60_000L))
    }

    @Test
    fun appUnpairAndExplicitPairingNeverReportOwnerLoss() {
        assertFalse(bondRemoved(msSinceAutoReconnectLink = 600L, killed = true))
        assertFalse(bondRemoved(msSinceAutoReconnectLink = 600L, unpairInProgress = true))
        assertFalse(bondRemoved(msSinceAutoReconnectLink = 600L, manualPairing = true))
    }

    @Test
    fun aFailedNewBondIsNotABondRemoval() {
        assertFalse(
                MentraLiveOwnerLossPolicy.shouldStandDownOnBondRemoved(
                        previousBondState = BluetoothDevice.BOND_BONDING,
                        bondState = BluetoothDevice.BOND_NONE,
                        killed = false,
                        unpairInProgress = false,
                        manualPairing = false,
                        msSinceAutoReconnectLink = 600L,
                )
        )
    }

    @Test
    fun yieldCoversTheAbsoluteWindow() {
        assertEquals(300_000L, MentraLiveOwnerLossPolicy.yieldMs(120_000L))
        assertEquals(300_000L, MentraLiveOwnerLossPolicy.yieldMs(900_000L))
    }

    @Test
    fun secureTargetIsNotReadyUntilBonded() {
        assertTrue(
                MentraLiveOwnerLossPolicy.shouldDeferReadyForBond(true, BluetoothDevice.BOND_BONDING)
        )
        assertTrue(MentraLiveOwnerLossPolicy.shouldDeferReadyForBond(true, BluetoothDevice.BOND_NONE))
        assertFalse(
                MentraLiveOwnerLossPolicy.shouldDeferReadyForBond(true, BluetoothDevice.BOND_BONDED)
        )
        assertFalse(
                MentraLiveOwnerLossPolicy.shouldDeferReadyForBond(false, BluetoothDevice.BOND_NONE)
        )
    }

    private fun bondRemoved(
            msSinceAutoReconnectLink: Long?,
            killed: Boolean = false,
            unpairInProgress: Boolean = false,
            manualPairing: Boolean = false,
    ): Boolean =
            MentraLiveOwnerLossPolicy.shouldStandDownOnBondRemoved(
                    previousBondState = BluetoothDevice.BOND_BONDED,
                    bondState = BluetoothDevice.BOND_NONE,
                    killed = killed,
                    unpairInProgress = unpairInProgress,
                    manualPairing = manualPairing,
                    msSinceAutoReconnectLink = msSinceAutoReconnectLink,
            )
}
