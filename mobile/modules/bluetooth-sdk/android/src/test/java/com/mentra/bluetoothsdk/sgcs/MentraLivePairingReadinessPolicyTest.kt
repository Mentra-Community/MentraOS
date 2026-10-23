package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothDevice
import com.mentra.bluetoothsdk.sgcs.MentraLivePairingReadinessPolicy.Readiness
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MentraLivePairingReadinessPolicyTest {
    private val bonded = BluetoothDevice.BOND_BONDED
    private val unbonded = BluetoothDevice.BOND_NONE

    @Test
    fun `constants match the spec`() {
        assertEquals(5_000L, MentraLivePairingReadinessPolicy.UNKNOWN_CAPABILITY_PAIRING_INFO_WAIT_MS)
        assertEquals(15_000L, MentraLivePairingReadinessPolicy.SECURE_FIRMWARE_REFRESH_MS)
    }

    @Test
    fun `the selected row decides and session pairing_info only fills an unknown row`() {
        val policy = MentraLivePairingReadinessPolicy
        assertTrue(policy.isSecurePairingTarget(true, null))
        assertTrue(policy.isSecurePairingTarget(true, false))
        // A row listed as legacy stays legacy (a rolled-back unit is never re-read as secure).
        assertFalse(policy.isSecurePairingTarget(false, true))
        assertFalse(policy.isSecurePairingTarget(false, null))
        assertTrue(policy.isSecurePairingTarget(null, true))
        assertFalse(policy.isSecurePairingTarget(null, false))
        assertFalse(policy.isSecurePairingTarget(null, null))
    }

    @Test
    fun `automatic reconnects are never gated`() {
        for (selected in listOf(true, false, null)) for (session in listOf(true, false, null)) {
            assertEquals(
                    Readiness.READY,
                    readiness(explicit = false, selected = selected, session = session, bond = unbonded),
            )
        }
    }

    @Test
    fun `unknown capability waits for pairing_info, then is legacy and ready without one`() {
        assertEquals(Readiness.AWAIT_PAIRING_INFO, readiness(selected = null, session = null))
        assertEquals(Readiness.READY, readiness(selected = null, session = null, expired = true))
    }

    @Test
    fun `unknown capability with a secure pairing_info follows the secure rule`() {
        assertEquals(Readiness.AWAIT_OWNER_COMMIT, readiness(selected = null, session = true, bond = unbonded))
        assertEquals(
                Readiness.AWAIT_OWNER_COMMIT,
                readiness(selected = null, session = true, bond = bonded, committed = false),
        )
        assertEquals(Readiness.READY, readiness(selected = null, session = true, bond = bonded, committed = true))
        // A late secure report after the wait expired still applies the secure rule.
        assertEquals(
                Readiness.AWAIT_OWNER_COMMIT,
                readiness(selected = null, session = true, expired = true, bond = unbonded),
        )
    }

    @Test
    fun `unknown capability with a legacy pairing_info is ready at once`() {
        assertEquals(Readiness.READY, readiness(selected = null, session = false, bond = unbonded))
    }

    @Test
    fun `known rows never wait for pairing_info`() {
        assertEquals(Readiness.AWAIT_OWNER_COMMIT, readiness(selected = true, session = null, bond = unbonded))
        assertEquals(Readiness.READY, readiness(selected = true, session = null, bond = bonded, committed = true))
        assertEquals(Readiness.READY, readiness(selected = false, session = null, bond = unbonded))
        assertEquals(Readiness.READY, readiness(selected = false, session = true, bond = unbonded))
    }

    @Test
    fun `readiness never waits without a deadline`() {
        for (explicit in listOf(true, false)) for (selected in listOf(true, false, null)) {
            for (session in listOf(true, false, null)) for (expired in listOf(true, false)) {
                for (bond in listOf(bonded, unbonded, BluetoothDevice.BOND_BONDING, null)) {
                    for (committed in listOf(true, false)) {
                        val result = readiness(explicit, selected, session, expired, bond, committed)
                        // The pairing_info wait is bounded: once it expired it never applies.
                        if (expired) assertNotEquals(Readiness.AWAIT_PAIRING_INFO, result)
                        // The owner-commit wait always runs the secure bond wait deadline.
                        if (result == Readiness.AWAIT_OWNER_COMMIT) {
                            assertTrue(
                                    MentraLiveOwnerLossPolicy.shouldRunSecureBondWait(
                                            explicit,
                                            MentraLivePairingReadinessPolicy.isSecurePairingTarget(selected, session),
                                    )
                            )
                        }
                    }
                }
            }
        }
    }

    @Test
    fun `a ready session without pairing_info clears the secure firmware memory`() {
        assertEquals(false, MentraLivePairingReadinessPolicy.secureFirmwareAfterReadySession(pairingInfoSeen = false))
        assertNull(MentraLivePairingReadinessPolicy.secureFirmwareAfterReadySession(pairingInfoSeen = true))
    }

    @Test
    fun `secure trailer memory starts empty with each scan`() {
        val memory = MentraLiveSecureTrailerScanMemory()
        memory.noteSecureTrailer("AA:BB:CC:DD:EE:01")
        assertTrue(memory.contains("AA:BB:CC:DD:EE:01"))
        assertFalse(memory.contains("AA:BB:CC:DD:EE:02"))
        assertFalse(memory.contains(null))
        memory.onScanStart()
        assertFalse(memory.contains("AA:BB:CC:DD:EE:01"))
    }

    private fun readiness(
            explicit: Boolean = true,
            selected: Boolean?,
            session: Boolean?,
            expired: Boolean = false,
            bond: Int? = unbonded,
            committed: Boolean = false,
    ): Readiness =
            MentraLivePairingReadinessPolicy.readiness(
                    explicitPairing = explicit,
                    selectedCapability = selected,
                    sessionPairingInfoSecure = session,
                    unknownCapabilityWaitExpired = expired,
                    bondState = bond,
                    ownerCommitted = committed,
            )
}
