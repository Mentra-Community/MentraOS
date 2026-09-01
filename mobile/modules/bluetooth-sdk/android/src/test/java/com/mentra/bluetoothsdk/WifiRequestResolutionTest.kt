package com.mentra.bluetoothsdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WifiRequestResolutionTest {
    @Test
    fun `capabilities are unknown per session until version info finalizes them`() {
        val capabilities = WifiSessionCapabilities()
        capabilities.reset("sid-1")

        assertEquals(WifiRequestMode.DISCOVERING, capabilities.forgetMode())
        assertEquals(WifiRequestMode.DISCOVERING, capabilities.savedNetworksMode())
        capabilities.applyVersionInfo1(mapOf("sid" to "sid-1", "wifiForgetResultVersion" to 1))

        assertEquals(WifiProtocolCapability.Supported(1), capabilities.forgetResult)
        assertEquals(WifiProtocolCapability.Unsupported, capabilities.savedNetworks)
        assertEquals(WifiRequestMode.MODERN, capabilities.forgetMode())
        assertEquals(WifiRequestMode.LEGACY, capabilities.savedNetworksMode())
    }

    @Test
    fun `new session resets capabilities and advances epoch`() {
        val capabilities = WifiSessionCapabilities()
        capabilities.reset("sid-1")
        capabilities.applyVersionInfo1(
            mapOf("wifiForgetResultVersion" to 1, "savedWifiNetworksVersion" to 1)
        )
        val oldEpoch = capabilities.epoch

        capabilities.reset("sid-2")

        assertTrue(capabilities.epoch > oldEpoch)
        assertEquals("sid-2", capabilities.sessionId)
        assertEquals(WifiProtocolCapability.Unknown, capabilities.forgetResult)
        assertEquals(WifiProtocolCapability.Unknown, capabilities.savedNetworks)
    }

    @Test
    fun `saved request snapshot cannot mix mode with a later session`() {
        val capabilities = WifiSessionCapabilities()
        capabilities.reset("sid-1")
        capabilities.applyVersionInfo1(mapOf("savedWifiNetworksVersion" to 1))
        val first = capabilities.savedNetworksRequestSnapshot()

        capabilities.reset("sid-2")
        val second = capabilities.savedNetworksRequestSnapshot()

        assertEquals(WifiRequestMode.MODERN, first.mode)
        assertEquals("sid-1", first.sessionId)
        assertEquals(WifiRequestMode.DISCOVERING, second.mode)
        assertEquals("sid-2", second.sessionId)
        assertTrue(second.epoch > first.epoch)
    }

    @Test
    fun `SSID validation rejects blank input without changing identity`() {
        assertFalse(wifiSsidIsValid("   "))
        assertTrue(wifiSsidIsValid(" Field AP "))
    }

    @Test
    fun `forget result requires exact id session ssid and protocol`() {
        val exact =
            mapOf<String, Any>(
                "requestId" to "forget-1",
                "sid" to "sid-1",
                "ssid" to " Field AP ",
                "protocolVersion" to 1,
                "outcome" to "dispatched",
                "connected" to false,
            )

        assertNull(parseWifiForgetResult("other", "sid-1", " Field AP ", 1, exact))
        assertNull(parseWifiForgetResult("forget-1", "sid-1", " Field AP ", 1, exact - "requestId"))
        assertNull(parseWifiForgetResult("forget-1", "other", " Field AP ", 1, exact))
        assertNull(parseWifiForgetResult("forget-1", "sid-1", "Field AP", 1, exact))
        assertNull(parseWifiForgetResult("forget-1", "sid-1", " Field AP ", 2, exact))
        assertEquals(
            WifiForgetOutcome.DISPATCHED,
            parseWifiForgetResult("forget-1", "sid-1", " Field AP ", 1, exact)?.outcome,
        )
    }

    @Test
    fun `forget parser preserves each honest terminal outcome`() {
        listOf("confirmed", "dispatched", "not_found", "unsupported", "failed").forEach { outcome ->
            val parsed =
                parseWifiForgetResult(
                    "forget-1",
                    "sid-1",
                    "AP",
                    1,
                    mapOf(
                        "requestId" to "forget-1",
                        "sid" to "sid-1",
                        "ssid" to "AP",
                        "protocolVersion" to 1,
                        "outcome" to outcome,
                    ),
                )
            assertEquals(outcome, parsed?.outcome?.wireValue)
        }
    }

    @Test
    fun `missing connectivity snapshot remains unknown`() {
        val parsed =
            parseWifiForgetResult(
                "forget-1",
                "sid-1",
                "AP",
                1,
                mapOf(
                    "requestId" to "forget-1",
                    "sid" to "sid-1",
                    "ssid" to "AP",
                    "protocolVersion" to 1,
                    "outcome" to "dispatched",
                ),
            )

        assertNull(parsed?.connected)
        assertFalse(parsed?.toMap()?.containsKey("connected") ?: true)
    }

    @Test
    fun `legacy forget is explicitly unverified`() {
        val result =
            legacyWifiForgetResult(
                "forget-1",
                "sid-legacy",
                "AP",
                WifiStatusEvent(connected = false, ssid = null, localIp = null),
            )

        assertEquals("legacy", result.mode)
        assertEquals(WifiForgetOutcome.LEGACY_UNVERIFIED, result.outcome)
    }

    @Test
    fun `saved list preserves exact identity and requires correlation tuple`() {
        val exact =
            mapOf<String, Any>(
                "requestId" to "saved-1",
                "sid" to "sid-1",
                "protocolVersion" to 1,
                "outcome" to "confirmed",
                "networks" to listOf(" Field AP ", "", "Field AP", " Field AP "),
            )

        assertNull(parseSavedWifiNetworks("other", "sid-1", 1, exact))
        assertNull(parseSavedWifiNetworks("saved-1", "sid-1", 1, exact - "requestId"))
        assertNull(parseSavedWifiNetworks("saved-1", "other", 1, exact))
        assertNull(parseSavedWifiNetworks("saved-1", "sid-1", 2, exact))
        assertEquals(
            listOf(" Field AP ", "Field AP"),
            parseSavedWifiNetworks("saved-1", "sid-1", 1, exact)?.networks,
        )

        val failure =
            parseSavedWifiNetworks(
                "saved-1",
                "sid-1",
                1,
                exact + ("outcome" to "failed") + ("error" to "backend_failed"),
            )
        assertEquals(SavedWifiNetworksOutcome.FAILED, failure?.outcome)
        assertEquals("backend_failed", failure?.error)
    }

    @Test
    fun `delayed callbacks require the same request and session epoch`() {
        assertTrue(wifiDelayedCallbackApplies(7, 7, true))
        assertFalse(wifiDelayedCallbackApplies(7, 8, true))
        assertFalse(wifiDelayedCallbackApplies(7, 7, false))
    }

    @Test
    fun `unknown capability has a bounded discovery deadline without selecting legacy`() {
        assertTrue(wifiCapabilityDiscoveryDeadlineRequired(WifiRequestMode.DISCOVERING))
        assertFalse(wifiCapabilityDiscoveryDeadlineRequired(WifiRequestMode.MODERN))
        assertFalse(wifiCapabilityDiscoveryDeadlineRequired(WifiRequestMode.LEGACY))
        assertEquals("capability_negotiation_timeout", WIFI_CAPABILITY_NEGOTIATION_TIMEOUT_CODE)
    }

    @Test
    fun `raw forget event preserves modern and legacy wire truth`() {
        val modern =
            normalizeWifiForgetResultEvent(
                "forget-1",
                "sid-1",
                "AP",
                1,
                "dispatched",
                null,
                false,
                "",
                "",
                null,
            )
        val legacy =
            normalizeWifiForgetResultEvent(
                "forget-old",
                "",
                "AP",
                0,
                "",
                true,
                false,
                "",
                "",
                null,
            )
        val withoutSnapshot =
            normalizeWifiForgetResultEvent(
                "forget-unknown",
                "sid-1",
                "AP",
                1,
                "dispatched",
                null,
                null,
                "",
                "",
                null,
            )

        assertEquals("modern", modern?.get("mode"))
        assertEquals("dispatched", modern?.get("outcome"))
        assertEquals("legacy", legacy?.get("mode"))
        assertEquals(true, legacy?.get("dispatched"))
        assertFalse(legacy?.containsKey("sid") ?: true)
        assertFalse(withoutSnapshot?.containsKey("connected") ?: true)
        assertNull(
            normalizeWifiForgetResultEvent(
                "bad", "", "AP", 0, "", null, false, "", "", null
            )
        )
    }

}
