package com.mentra.acsmeeting

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CallCapabilitiesTest {

    @Test
    fun `an allowed capability proceeds`() {
        assertNull(EndForEveryonePolicy.refusalFor(CapabilityStatus(allowed = true, reason = "capable")))
    }

    @Test
    fun `a denied capability is refused with its reason`() {
        assertEquals(
            "hang_up_for_everyone_not_allowed:role_restricted",
            EndForEveryonePolicy.refusalFor(CapabilityStatus(allowed = false, reason = "role_restricted")),
        )
    }

    @Test
    fun `a denied capability with no reason still names itself`() {
        assertEquals(
            "hang_up_for_everyone_not_allowed:unknown",
            EndForEveryonePolicy.refusalFor(CapabilityStatus(allowed = false, reason = "  ")),
        )
    }

    /**
     * Unknown is the ordinary state between joining and the first capabilities event. Treating it as
     * a refusal would hide End on every call that taps it early; letting ACS answer is honest.
     */
    @Test
    fun `an unknown capability is attempted, not refused`() {
        assertNull(EndForEveryonePolicy.refusalFor(CapabilityStatus()))
        assertNull(EndForEveryonePolicy.refusalFor(CapabilityStatus(reason = "capabilities_unavailable")))
    }

    @Test
    fun `serializes the tri-state for the miniapp`() {
        assertEquals(
            mapOf("allowed" to null, "reason" to "not_reported"),
            CapabilityStatus(reason = "not_reported").toMap(),
        )
    }
}
