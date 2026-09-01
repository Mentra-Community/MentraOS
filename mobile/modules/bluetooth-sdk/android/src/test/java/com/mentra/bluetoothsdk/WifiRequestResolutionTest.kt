package com.mentra.bluetoothsdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WifiRequestResolutionTest {
    @Test
    fun `SSID validation rejects blank input without changing identity`() {
        assertFalse(wifiSsidIsValid("   "))
        assertTrue(wifiSsidIsValid(" Field AP "))
    }

    @Test
    fun `forget result requires exact request id`() {
        val base = mapOf<String, Any>("ssid" to " Field AP ", "dispatched" to true)

        assertNull(parseWifiForgetResult("forget-1", " Field AP ", base))
        assertNull(
            parseWifiForgetResult(
                "forget-1",
                " Field AP ",
                base + ("requestId" to "forget-other"),
            )
        )
        assertTrue(
            parseWifiForgetResult(
                "forget-1",
                " Field AP ",
                base + ("requestId" to "forget-1"),
            ) is ParsedWifiForgetResult.Dispatched
        )
    }

    @Test
    fun `correlated failure remains terminal during legacy priority window`() {
        assertTrue(wifiForgetLegacyFallbackDelayMs(1_750L, 1_000L) > 0L)
        val result =
            parseWifiForgetResult(
                "forget-1",
                "Field AP",
                mapOf(
                    "requestId" to "forget-1",
                    "ssid" to "Field AP",
                    "dispatched" to false,
                    "error" to "forget_dispatch_failed",
                ),
            )

        assertEquals(
            "forget_dispatch_failed",
            (result as ParsedWifiForgetResult.Failure).error,
        )
    }

    @Test
    fun `legacy fallback waits only for bounded correlated priority window`() {
        assertEquals(750L, wifiForgetLegacyFallbackDelayMs(1_750L, 1_000L))
        assertEquals(0L, wifiForgetLegacyFallbackDelayMs(1_750L, 1_750L))
        assertEquals(0L, wifiForgetLegacyFallbackDelayMs(1_750L, 2_000L))
    }

    @Test
    fun `delayed fallback is no op after timeout or replacement`() {
        assertTrue(wifiForgetFallbackStillApplies("forget-1", "forget-1"))
        assertFalse(wifiForgetFallbackStillApplies("forget-1", null))
        assertFalse(wifiForgetFallbackStillApplies("forget-1", "forget-2"))
    }

    @Test
    fun `saved list preserves exact SSID identity`() {
        val result =
            parseSavedWifiNetworks(
                "saved-1",
                mapOf(
                    "requestId" to "saved-1",
                    "networks" to listOf(" Field AP ", "", "Field AP", " Field AP "),
                ),
            )

        assertEquals(listOf(" Field AP ", "Field AP"), result?.networks)
        assertNull(result?.error)
    }

    @Test
    fun `saved list rejects wrong id and parses terminal error`() {
        assertNull(
            parseSavedWifiNetworks(
                "saved-1",
                mapOf("requestId" to "saved-other", "networks" to emptyList<String>()),
            )
        )
        assertEquals(
            "list_saved_networks_unsupported",
            parseSavedWifiNetworks(
                "saved-1",
                mapOf(
                    "requestId" to "saved-1",
                    "networks" to emptyList<String>(),
                    "error" to "list_saved_networks_unsupported",
                ),
            )?.error,
        )
    }
}
