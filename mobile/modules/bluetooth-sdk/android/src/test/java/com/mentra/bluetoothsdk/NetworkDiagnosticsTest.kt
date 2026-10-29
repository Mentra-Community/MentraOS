package com.mentra.bluetoothsdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class NetworkDiagnosticsTest {
    private val validatedInternet = mapOf("internet" to true, "validated" to true)
    private val localOnly = mapOf("internet" to false, "validated" to false)

    @Test
    fun `distinguishes a process bound to glasses from a validated active network`() {
        val snapshot = networkDiagnostics(123L, "private-glasses", "private-cellular", "private-glasses") {
            if (it == "private-cellular") validatedInternet else localOnly
        }

        assertEquals(123L, snapshot["sampledAtMs"])
        assertEquals(false, snapshot["processBoundMatchesActive"])
        assertEquals(true, snapshot["processBoundMatchesGlassesLocal"])
        assertEquals(false, snapshot["activeNetworkMatchesGlassesLocal"])
        assertEquals(validatedInternet, observation(snapshot, "activeNetwork")["capabilities"])
        assertFalse(snapshot.toString().contains("private-"))
    }

    @Test
    fun `keeps an unvalidated active network distinct from a disappeared network`() {
        val unvalidated = networkDiagnostics(124L, null, "default", null) { localOnly }
        assertEquals(localOnly, observation(unvalidated, "activeNetwork")["capabilities"])
        val disappeared = networkDiagnostics(125L, null, "default", null) { null }
        assertEquals(true, observation(disappeared, "activeNetwork")["present"])
        assertNull(observation(disappeared, "activeNetwork")["capabilities"])
    }

    @Test
    fun `no network does not imply equal routes or attempt a capability read`() {
        var read = false
        val snapshot = networkDiagnostics<String>(126L, null, null, null) {
            read = true
            validatedInternet
        }

        assertFalse(read)
        listOf("processBound", "activeNetwork", "glassesLocal").forEach {
            assertEquals(false, observation(snapshot, it)["present"])
            assertNull(observation(snapshot, it)["capabilities"])
        }
        assertEquals(false, snapshot["processBoundMatchesActive"])
        assertEquals(false, snapshot["processBoundMatchesGlassesLocal"])
        assertEquals(false, snapshot["activeNetworkMatchesGlassesLocal"])
    }

    @Suppress("UNCHECKED_CAST")
    private fun observation(snapshot: Map<String, Any?>, name: String) = snapshot[name] as Map<String, Any?>
}
