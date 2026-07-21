package com.mentra.bluetoothsdk

import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class OtaManifestDowngradeTest {

    private fun manifest(versionCode: Long, allowDowngrade: Boolean?): JSONObject {
        val app = JSONObject().put("versionCode", versionCode)
        if (allowDowngrade != null) {
            app.put("allowDowngrade", allowDowngrade)
        }
        return JSONObject()
            .put("apps", JSONObject().put("com.mentra.asg_client", app))
    }

    private fun hasUpdate(currentBuildNumber: String, manifest: JSONObject): Boolean =
        OtaManifestChecker.hasUpdate(
            currentBuildNumber = currentBuildNumber,
            currentMtkVersion = "",
            currentBesVersion = "",
            manifest = manifest,
        )

    @Test
    fun fleetManifestStaysUpgradeOnly() {
        // No allowDowngrade flag: a lower pinned version is not an update.
        assertFalse(hasUpdate("49076573", manifest(49000000L, allowDowngrade = null)))
        assertFalse(hasUpdate("49076573", manifest(49000000L, allowDowngrade = false)))
        assertTrue(hasUpdate("49000000", manifest(49076573L, allowDowngrade = null)))
    }

    @Test
    fun pinnedManifestFlagsAnyMismatch() {
        assertTrue(hasUpdate("49076573", manifest(49000000L, allowDowngrade = true)))
        assertTrue(hasUpdate("49000000", manifest(49076573L, allowDowngrade = true)))
    }

    @Test
    fun exactPinIsNotAnUpdate() {
        assertFalse(hasUpdate("49076573", manifest(49076573L, allowDowngrade = true)))
    }
}
