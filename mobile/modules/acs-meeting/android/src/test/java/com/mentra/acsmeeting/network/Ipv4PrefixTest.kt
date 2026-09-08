package com.mentra.acsmeeting.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class Ipv4PrefixTest {

    @Test
    fun `contains the phone and the gateway on a 24`() {
        val prefix = Ipv4Prefix("192.168.43.20", 24)
        assertTrue(prefix.contains("192.168.43.1"))
        assertTrue(prefix.contains("192.168.43.20"))
        assertTrue(prefix.contains("192.168.43.255"))
    }

    /** The whole point: a cellular 10/8 address is RFC1918 and still the wrong interface. */
    @Test
    fun `rejects a private address on another interface`() {
        val prefix = Ipv4Prefix("192.168.43.20", 24)
        assertFalse(prefix.contains("10.171.36.4"))
        assertFalse(prefix.contains("192.168.1.20"))
        assertFalse(prefix.contains("172.16.0.1"))
    }

    /** An OEM hotspot on another subnet must still pass, which is why /24 is never assumed. */
    @Test
    fun `honours the reported prefix length`() {
        assertTrue(Ipv4Prefix("192.168.49.1", 16).contains("192.168.43.7"))
        assertFalse(Ipv4Prefix("192.168.49.1", 24).contains("192.168.43.7"))
        assertTrue(Ipv4Prefix("10.5.4.3", 8).contains("10.99.99.99"))
    }

    @Test
    fun `non-addresses are not addresses`() {
        val prefix = Ipv4Prefix("192.168.43.20", 24)
        assertFalse(prefix.contains(null))
        assertFalse(prefix.contains("typ"))
        assertFalse(prefix.contains("192.168.43"))
        assertFalse(prefix.contains("192.168.43.256"))
        assertFalse(prefix.contains("192.168.43.20.1"))
        assertFalse(prefix.contains("a4f1c2d3.local"))
    }

    @Test
    fun `packs and prints`() {
        assertEquals(0x0A000001, Ipv4Prefix.packIpv4("10.0.0.1"))
        assertNull(Ipv4Prefix.packIpv4("not.an.ip.addr"))
        assertEquals("192.168.43.20/24", Ipv4Prefix("192.168.43.20", 24).toString())
    }

    /** An unparseable own-address must match nothing rather than everything. */
    @Test
    fun `a malformed prefix contains nothing`() {
        assertFalse(Ipv4Prefix("garbage", 24).contains("192.168.43.1"))
    }
}
