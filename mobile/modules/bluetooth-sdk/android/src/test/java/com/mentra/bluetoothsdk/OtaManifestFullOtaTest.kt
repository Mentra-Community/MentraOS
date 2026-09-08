package com.mentra.bluetoothsdk

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class OtaManifestFullOtaTest {
    private fun full(): JSONObject = JSONObject()
        .put("end_firmware", "MentraLive_20260908.10")
        .put("url", "https://cdn/full.zip").put("sha256", "a".repeat(64)).put("size", 640341205)

    private fun hasUpdate(manifest: JSONObject, current: String): Boolean =
        OtaManifestChecker.hasUpdate("38", current, "", manifest.put("versionCode", 38))

    @Test fun fullIsUpgradeOnlyWithNumericRevisionComparison() {
        val manifest = JSONObject().put("mtk_full_ota", full())
        assertTrue(OtaManifestChecker.hasMtkPatches(manifest))
        for (current in listOf("20260709", "MentraLive_20260908.9", "20260907.20")) {
            assertTrue(current, hasUpdate(manifest, current))
        }
        for (current in listOf("", "unknown", "20260908.10", "20260908.11", "20260909")) {
            assertFalse(current, hasUpdate(manifest, current))
        }
        manifest.put("mtk_full_ota", full().put("end_firmware", "20260908.0"))
        assertFalse(hasUpdate(manifest, "20260908"))
    }

    @Test fun deltaRemainsAvailableAndFullNeedsMetadata() {
        assertFalse(hasUpdate(JSONObject().put("mtk_full_ota", full().put("end_firmware", 20260908)), "20260709"))
        for (start in listOf(JSONObject.NULL, "20260709")) {
            assertFalse(hasUpdate(JSONObject().put("mtk_full_ota", full().put("start_firmware", start)), "20260709"))
        }
        val delta = JSONObject().put("start_firmware", "20260709")
        assertTrue(hasUpdate(JSONObject().put("mtk_patches", JSONArray().put(delta)), "MentraLive_20260709"))
        assertFalse(hasUpdate(JSONObject(), "20260709"))
        for (key in listOf("end_firmware", "url", "sha256", "size")) {
            val invalid = full().apply { remove(key) }
            assertFalse(key, hasUpdate(JSONObject().put("mtk_full_ota", invalid), "20260709"))
        }
        for (size in listOf(2147483648L, "640341205", 1.5)) {
            assertFalse(hasUpdate(JSONObject().put("mtk_full_ota", full().put("size", size)), "20260709"))
        }
    }
}
