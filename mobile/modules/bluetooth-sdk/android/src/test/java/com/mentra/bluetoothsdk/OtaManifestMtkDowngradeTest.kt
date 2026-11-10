package com.mentra.bluetoothsdk

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class OtaManifestMtkDowngradeTest {
    private val current = "MentraLive_20260923.0"

    private fun pinning(end: String): JSONObject = JSONObject().put(
        "mtk_full_ota",
        JSONObject().put("end_firmware", end).put("url", "https://cdn/full.zip")
            .put("sha256", "a".repeat(64)).put("size", 640339273),
    )

    private fun record(start: String = current, end: String = "MentraLive_20260709"): JSONObject = JSONObject()
        .put("start_firmware", start).put("end_firmware", end)
        .put("url", "https://mtkfirmware.mentraglass.com/down.zip").put("sha256", "b".repeat(64)).put("size", 15179481)

    @Test fun targetsTheOlderPinnedMtkNeverBelowMentra30() {
        assertEquals("20260709", OtaManifestChecker.mtkDowngradeTarget(pinning("MentraLive_20260709"), current))
        assertNull(OtaManifestChecker.mtkDowngradeTarget(pinning("MentraLive_20260626"), current))
        assertNull(OtaManifestChecker.mtkDowngradeTarget(pinning("MentraLive_20260709"), "MentraLive_20260709"))
        assertNull(OtaManifestChecker.mtkDowngradeTarget(pinning("MentraLive_20261001.0"), current))
        val legacy = JSONArray()
            .put(JSONObject().put("start_firmware", "MentraLive_20260113").put("end_firmware", "MentraLive_20260709"))
            .put(JSONObject().put("start_firmware", "MentraLive_20260626").put("end_firmware", "MentraLive_20260709"))
        assertEquals("20260709", OtaManifestChecker.mtkDowngradeTarget(JSONObject().put("mtk_patches", legacy), current))
    }

    @Test fun thePublishedRecordDecides() {
        val urls = mutableListOf<String>()
        assertTrue(OtaManifestChecker.hasMtkDowngrade(pinning("MentraLive_20260709"), current) { urls += it; record() })
        assertEquals(listOf("https://mtkfirmware.mentraglass.com/mtk_ota_downgrade_20260923.0_20260709.json"), urls)
        assertFalse(OtaManifestChecker.hasMtkDowngrade(pinning("MentraLive_20260709"), current) { null })
        assertFalse(
            OtaManifestChecker.hasMtkDowngrade(pinning("MentraLive_20260709"), current) { record(start = "MentraLive_20260801") },
        )
        assertFalse(OtaManifestChecker.hasMtkDowngrade(pinning("MentraLive_20260709"), current) { record().apply { remove("sha256") } })
        assertFalse(OtaManifestChecker.hasMtkDowngrade(pinning("MentraLive_20260626"), current) { record(end = "MentraLive_20260626") })
    }
}
