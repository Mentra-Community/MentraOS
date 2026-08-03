package com.mentra.bluetoothsdk

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
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

    private fun hasUpdate(
        currentBuildNumber: String,
        manifest: JSONObject,
        floor: Long = 0L,
    ): Boolean =
        OtaManifestChecker.hasUpdate(
            currentBuildNumber = currentBuildNumber,
            currentMtkVersion = "",
            currentBesVersion = "",
            manifest = manifest,
            downgradeFloorVersionCode = floor,
        )

    @Test
    fun upgradeIsAlwaysAnUpdate() {
        assertTrue(hasUpdate("49000000", manifest(49076573L)))
    }

    @Test
    fun exactPinIsNotAnUpdateEvenWithAnEnabledFloor() {
        assertFalse(hasUpdate("49000000", manifest(49000000L), floor = 49000000L))
    }

    @Test
    fun downgradeNeedsAnEnabledFloor() {
        // Default floor 0 (fail closed) disables downgrades for native/OEM callers.
        assertFalse(hasUpdate("49076573", manifest(49000000L)))
        // A positive floor at/below the pin enables it.
        assertTrue(hasUpdate("49076573", manifest(49000000L), floor = 49000000L))
        // A pin below the floor is refused.
        assertFalse(hasUpdate("49076573", manifest(48999999L), floor = 49000000L))
    }

    @Test
    fun exactPinIsNotAnUpdate() {
        assertFalse(hasUpdate("49076573", manifest(49076573L)))
    }

    private fun legacyTopLevelManifest(versionCode: Long): JSONObject =
        JSONObject().put("versionCode", versionCode)

    @Test
    fun legacyTopLevelManifestStaysUpgradeOnly() {
        // No apps entry -> not an exact pin -> upgrade-only, never a false downgrade.
        assertFalse(hasUpdate("49076573", legacyTopLevelManifest(49000000L)))
        assertTrue(hasUpdate("49000000", legacyTopLevelManifest(49076573L)))
    }

    @Test
    fun zeroedPinOnModernGlassesIsAnError() {
        // An unverifiable pin must never present as "no update" on modern glasses.
        try {
            hasUpdate("49076573", manifest(0L))
            fail("expected invalid_ota_manifest")
        } catch (e: BluetoothSdkException) {
            assertEquals("invalid_ota_manifest", e.code)
        }
    }

    @Test
    fun zeroedRescuePinIsInertForLegacyGlasses() {
        // Pre-39 glasses are legitimately checked against the frozen rescue manifests, whose
        // zeroed ASG pin must read as no APK update (the MTK patch chain is what matters there).
        assertFalse(hasUpdate("38", manifest(0L)))
    }
}
