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

    private fun manifest(versionCode: Long): JSONObject =
        JSONObject()
            .put("apps", JSONObject().put("com.mentra.asg_client", JSONObject().put("versionCode", versionCode)))

    private fun hasUpdate(currentBuildNumber: String, manifest: JSONObject): Boolean =
        OtaManifestChecker.hasUpdate(
            currentBuildNumber = currentBuildNumber,
            currentMtkVersion = "",
            currentBesVersion = "",
            manifest = manifest,
        )

    @Test
    fun anyPinMismatchIsAnUpdate() {
        // Every manifest is an exact pin: both directions are actionable.
        assertTrue(hasUpdate("49076573", manifest(49000000L)))
        assertTrue(hasUpdate("49000000", manifest(49076573L)))
    }

    @Test
    fun exactPinIsNotAnUpdate() {
        assertFalse(hasUpdate("49076573", manifest(49076573L)))
    }

    @Test
    fun zeroedRescuePinIsNeverActionable() {
        // The frozen legacy rescue manifests carry a zeroed ASG pin; it must never read as an
        // update (especially not as a downgrade to versionCode 0).
        assertFalse(hasUpdate("49076573", manifest(0L)))
    }
}
