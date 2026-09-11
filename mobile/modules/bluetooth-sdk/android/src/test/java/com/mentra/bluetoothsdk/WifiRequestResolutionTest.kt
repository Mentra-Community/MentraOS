package com.mentra.bluetoothsdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WifiRequestResolutionTest {
    @Test
    fun `future fractional and malformed capabilities are unsupported not legacy`() {
        for (version in listOf(0, 2, -1, 1.5, "1", true)) {
            val capabilities = WifiSessionCapabilities()
            capabilities.reset("sid")
            capabilities.applyVersionInfo1(mapOf("wifiForgetResultVersion" to version, "savedWifiNetworksVersion" to version))
            assertEquals(WifiRequestMode.UNSUPPORTED, capabilities.forgetMode())
            assertEquals(WifiRequestMode.UNSUPPORTED, capabilities.savedNetworksMode())
        }
        val missingSession = WifiSessionCapabilities()
        missingSession.applyVersionInfo1(mapOf("wifiForgetResultVersion" to 1))
        assertEquals(WifiRequestMode.UNSUPPORTED, missingSession.forgetMode())
    }

    @Test
    fun `raw response rejects partial tuples and coercion before normalization`() {
        val tuple = mapOf<String, Any>("protocol_version" to 1, "requestId" to "request", "sid" to "sid")
        assertTrue(wifiResponseEnvelopeIsValid(tuple, false))
        for (key in tuple.keys) assertFalse(wifiResponseEnvelopeIsValid(tuple - key, true))
        for (version in listOf(0, 2, 1.5, "1", true)) {
            assertFalse(wifiResponseEnvelopeIsValid(tuple + ("protocol_version" to version), true))
        }
        assertFalse(wifiResponseEnvelopeIsValid(tuple + ("connected" to 0), true))
        assertFalse(wifiResponseEnvelopeIsValid(tuple + ("dispatched" to true), true))
        assertTrue(wifiResponseEnvelopeIsValid(mapOf("dispatched" to true), true))
        assertFalse(wifiResponseEnvelopeIsValid(mapOf("requestId" to "", "dispatched" to true), true))
        assertFalse(wifiResponseEnvelopeIsValid(emptyMap(), false))
    }

    @Test
    fun `semantic results omit transport metadata`() {
        val data = mapOf<String, Any>("requestId" to "request", "sid" to "sid", "protocolVersion" to 1,
            "ssid" to "AP", "outcome" to "confirmed", "networks" to listOf("AP"))
        val forbidden = setOf("mode", "capabilityVersion", "requestId", "sid", "protocolVersion")
        assertTrue(parseWifiForgetResult("request", "sid", "AP", 1, data)!!.toMap().keys.intersect(forbidden).isEmpty())
        assertTrue(parseSavedWifiNetworks("request", "sid", 1, data)!!.toMap().keys.intersect(forbidden).isEmpty())
        assertNull(parseWifiForgetResult("request", "sid", "AP", 1, data + ("protocolVersion" to 1.5)))
        assertNull(parseSavedWifiNetworks("request", "sid", 1, data + ("protocolVersion" to 1.5)))
    }

    @Test
    fun `capabilities are unknown per session until version info finalizes them`() {
        val capabilities = WifiSessionCapabilities()
        capabilities.reset("sid-1")

        assertEquals(WifiRequestMode.DISCOVERING, capabilities.forgetMode())
        assertEquals(WifiRequestMode.DISCOVERING, capabilities.savedNetworksMode())
        capabilities.applyVersionInfo1(mapOf("sid" to "sid-1", "wifiForgetResultVersion" to 1))

        assertEquals(WifiProtocolCapability.Supported(1), capabilities.forgetResult)
        assertEquals(WifiProtocolCapability.Legacy, capabilities.savedNetworks)
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
                "AP",
            )

        assertFalse(result.toMap().keys.any { it in setOf("mode", "capabilityVersion", "requestId", "sid") })
        assertEquals(WifiForgetOutcome.LEGACY_UNVERIFIED, result.outcome)
        assertNull(result.connected)
        assertNull(result.currentSsid)
        assertNull(result.localIp)
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
                exact + ("outcome" to "failed") + ("error" to "backend_failed") + ("networks" to emptyList<String>()),
            )
        assertEquals(SavedWifiNetworksOutcome.FAILED, failure?.outcome)
        assertEquals("backend_failed", failure?.error)
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
                "",
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
