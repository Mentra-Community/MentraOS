package com.mentra.bluetoothsdk

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class OtaManifestCheckerTest {
    @Test
    fun `logical mismatch supports upgrades and downgrades`() {
        val manifest = manifest(asgVersion = 200, versionCode = 1_000_000_000)

        assertFalse(OtaManifestChecker.hasUpdate(200, "1000000000", "", "", manifest))
        assertTrue(OtaManifestChecker.hasUpdate(199, "1000000000", "", "", manifest))
        assertTrue(OtaManifestChecker.hasUpdate(201, "1000000000", "", "", manifest))
    }

    @Test
    fun `legacy manifests and glasses fall back to versionCode`() {
        val manifest = manifest(asgVersion = null, versionCode = 47_442_366)

        assertFalse(OtaManifestChecker.hasUpdate(null, "47442366", "", "", manifest))
        assertTrue(OtaManifestChecker.hasUpdate(null, "47442365", "", "", manifest))
    }

    private fun manifest(asgVersion: Long?, versionCode: Long): JSONObject {
        val app = JSONObject().put("versionCode", versionCode)
        asgVersion?.let { app.put("asgVersion", it) }
        return JSONObject().put("apps", JSONObject().put("com.mentra.asg_client", app))
    }
}
