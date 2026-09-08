package com.mentra.acsmeeting.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Covers the parts of [InternetHold] that decide something, which is the verdict on a default
 * network and the name that verdict is reported under. The framework plumbing around them
 * (`requestNetwork`, `activeNetwork`) is not reachable from a plain JVM test and is not what went
 * wrong on device: the failure was proceeding on an unvalidated route, and that judgement lives
 * here.
 */
class InternetHoldTest {

    @Test
    fun `a present validated network is the only usable one`() {
        assertTrue(InternetHold.DefaultNetwork("cellular", validated = true, present = true).usable)
    }

    @Test
    fun `a network that is up but not validated is not usable`() {
        // The device failure exactly: cellular present, carrying no TLS, and ACS joining over it.
        val cellular = InternetHold.DefaultNetwork("cellular", validated = false, present = true)
        assertFalse(cellular.usable)
        assertEquals("cellular (unvalidated)", cellular.toString())
    }

    @Test
    fun `no default network at all is reported as none rather than as an unvalidated one`() {
        // Distinct causes need distinct copy: "no network" is airplane mode, "unvalidated" is a
        // radio that is up and not working yet.
        val absent = InternetHold.DefaultNetwork("none", validated = false, present = false)
        assertFalse(absent.usable)
        assertEquals("none", absent.toString())
    }

    @Test
    fun `a validated network cannot be usable while absent`() {
        // Guards against reading a stale capability snapshot as a live route.
        assertFalse(InternetHold.DefaultNetwork("cellular", validated = true, present = false).usable)
    }

    @Test
    fun `a validated cellular network renders with its transport and state`() {
        assertEquals(
            "cellular (validated)",
            InternetHold.DefaultNetwork("cellular", validated = true, present = true).toString(),
        )
    }

    @Test
    fun `a vpn is named ahead of the transport it runs over`() {
        // A tunnel owning the app's UID is what decides whether ACS reaches the internet, and it
        // stacks on cellular rather than replacing it. Naming the carrier would hide the cause of
        // the EPERM failures we chased.
        assertEquals(
            "vpn",
            InternetHold.transportNameOf(cellular = true, wifi = false, vpn = true, ethernet = false),
        )
        assertEquals(
            "vpn",
            InternetHold.transportNameOf(cellular = false, wifi = true, vpn = true, ethernet = false),
        )
    }

    @Test
    fun `each transport has a name and an unknown mix does not crash the trace`() {
        assertEquals(
            "cellular",
            InternetHold.transportNameOf(cellular = true, wifi = false, vpn = false, ethernet = false),
        )
        assertEquals(
            "wifi",
            InternetHold.transportNameOf(cellular = false, wifi = true, vpn = false, ethernet = false),
        )
        assertEquals(
            "ethernet",
            InternetHold.transportNameOf(cellular = false, wifi = false, vpn = false, ethernet = true),
        )
        assertEquals(
            "other",
            InternetHold.transportNameOf(cellular = false, wifi = false, vpn = false, ethernet = false),
        )
    }

    @Test
    fun `cellular is named over wifi when both are present`() {
        // Only reached when the app's default has both transports; cellular is the one this class
        // holds up, so it is the one worth naming.
        assertEquals(
            "cellular",
            InternetHold.transportNameOf(cellular = true, wifi = true, vpn = false, ethernet = false),
        )
    }

    @Test
    fun `a hold that could not be taken reports neither held nor validated`() {
        val none = InternetHold.CellularHold(held = false, validated = false, waitedMs = 0)
        assertFalse(none.held)
        assertFalse(none.validated)
    }

    @Test
    fun `a held request that never validated is still recorded as held`() {
        // The request is deliberately kept after a validation timeout, so that a caller which
        // continues anyway does not also lose the radio. Losing this distinction would make the
        // release path look unnecessary.
        val held = InternetHold.CellularHold(held = true, validated = false, waitedMs = 15_000)
        assertTrue(held.held)
        assertFalse(held.validated)
        assertEquals(15_000, held.waitedMs)
    }

    @Test
    fun `the cellular wait is longer than the default-route wait`() {
        // Bringing a radio up from cold is slow; a default route swapping to a network already up
        // is not. Equal budgets would either abort good calls or stall every one of them.
        assertTrue(InternetHold.CELLULAR_WAIT_MS > InternetHold.DEFAULT_WAIT_MS)
    }
}
