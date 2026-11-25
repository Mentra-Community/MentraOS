package com.mentra.bluetoothsdk.status

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GlassesAppCapabilitiesTest {
    @Test
    fun theChunkThatNamesTheAppSaysWhatItSupports() {
        val fields = mapOf<String, Any?>(
            "package_name" to "com.mentra.asg_client",
            "deferred_photos" to 1,
            "wifi_direct_version" to 1,
            "hotspot_ota_version" to 2,
        )
        assertEquals(GlassesAppCapabilities(deferredPhotos = 1, wifiDirect = 1, hotspotOta = 2), GlassesAppCapabilities.from(fields))
    }

    @Test
    fun anAppRestartedOnOlderSoftwareHasNoneOfWhatItDoesNotName() {
        // A 3.3.0 service app, after an update from one that had Wi-Fi Direct and deferred photos.
        val fields = mapOf<String, Any?>("package_name" to "com.mentra.asg_client", "app_version" to "3.3.0")
        assertEquals(GlassesAppCapabilities(deferredPhotos = 0, wifiDirect = 0, hotspotOta = 0), GlassesAppCapabilities.from(fields))
    }

    @Test
    fun aFirmwareChunkDoesNotSpeakForTheApp() {
        assertNull(GlassesAppCapabilities.from(mapOf("bes_fw_version" to "3.5.0.169", "mtk_fw_version" to "MentraLive_20260923.0")))
    }
}
