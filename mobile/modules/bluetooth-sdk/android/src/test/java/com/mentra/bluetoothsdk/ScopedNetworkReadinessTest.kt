package com.mentra.bluetoothsdk

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScopedNetworkReadinessTest {
    @Test
    fun `waits for the available network to become foreground`() {
        val readiness = ScopedNetworkReadiness<String>()

        readiness.onAvailable("glasses")

        assertFalse(readiness.isReady("glasses", isForeground = false))
        assertTrue(readiness.isReady("glasses", isForeground = true))
    }

    @Test
    fun `rejects capabilities from a stale network`() {
        val readiness = ScopedNetworkReadiness<String>()

        readiness.onAvailable("old")
        readiness.onAvailable("current")

        assertFalse(readiness.isReady("old", isForeground = true))
        assertTrue(readiness.isReady("current", isForeground = true))
    }

    @Test
    fun `clears the candidate when the request ends`() {
        val readiness = ScopedNetworkReadiness<String>()
        readiness.onAvailable("glasses")

        readiness.clear()

        assertFalse(readiness.contains("glasses"))
        assertFalse(readiness.isReady("glasses", isForeground = true))
    }
}
