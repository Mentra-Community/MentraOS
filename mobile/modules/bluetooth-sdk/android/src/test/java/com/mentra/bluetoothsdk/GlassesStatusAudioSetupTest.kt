package com.mentra.bluetoothsdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class GlassesStatusAudioSetupTest {
    private val notApplicable = mapOf("state" to "not_applicable")
    private val idle = mapOf("state" to "idle")

    @Test
    fun `a ready snapshot carries not_applicable`() {
        val status = GlassesStatus.fromMap(mapOf("fullyBooted" to true, "connected" to true))
        assertEquals(notApplicable, status.audioSetup)
        assertEquals(notApplicable, status.toMap()["audioSetup"])
    }

    @Test
    fun `a snapshot without a ready session carries idle`() {
        assertEquals(idle, GlassesStatus.fromMap(mapOf("fullyBooted" to false)).toMap()["audioSetup"])
        // Connected but not yet ready (for example parked for the owner commit) is still idle.
        assertEquals(
                idle,
                GlassesStatus.fromMap(mapOf("fullyBooted" to false, "connected" to true)).toMap()["audioSetup"],
        )
        assertEquals(idle, GlassesStatus.fromMap(emptyMap()).toMap()["audioSetup"])
    }

    @Test
    fun `audioSetup follows readiness, never a stored copy`() {
        // Even if something wrote a stale value, the snapshot reports the readiness rule.
        val status = GlassesStatus.fromMap(mapOf("fullyBooted" to true, "audioSetup" to idle))
        assertEquals(notApplicable, status.toMap()["audioSetup"])
    }

    @Test
    fun `an update that marks the glasses ready carries not_applicable in the same update`() {
        assertEquals(notApplicable, GlassesStatusUpdate(fullyBooted = true).toMap()["audioSetup"])
        assertEquals(idle, GlassesStatusUpdate(fullyBooted = false).toMap()["audioSetup"])
        assertFalse(GlassesStatusUpdate(batteryLevel = 50).toMap().containsKey("audioSetup"))
    }

    @Test
    fun `update maps keep only a known audio setup state`() {
        val needsUser = mapOf("state" to "needs_user", "action" to "connect_in_settings")
        assertEquals(needsUser, GlassesStatusUpdate.fromMap(mapOf("audioSetup" to needsUser)).audioSetup)
        assertNull(GlassesStatusUpdate.fromMap(mapOf("audioSetup" to mapOf("state" to "bogus"))).audioSetup)
        assertNull(GlassesStatusUpdate.fromMap(mapOf("audioSetup" to "connected")).audioSetup)
    }
}
