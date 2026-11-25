package com.mentra.bluetoothsdk.status

/**
 * What the glasses' service app supports, from the `version_info` chunk that names its package
 * (`version_info_1`). A capability that chunk doesn't name is one the app doesn't have: after an
 * update to older software the app restarts with the BLE link up, and its old capabilities must go.
 */
internal data class GlassesAppCapabilities(val deferredPhotos: Int, val wifiDirect: Int, val hotspotOta: Int) {
    companion object {
        /** Null for a chunk that doesn't speak for the app (it doesn't name its package). */
        fun from(fields: Map<String, Any?>): GlassesAppCapabilities? {
            if (!fields.containsKey("package_name")) return null
            val version = { key: String -> (fields[key] as? Number)?.toInt() ?: 0 }
            return GlassesAppCapabilities(
                deferredPhotos = version("deferred_photos"),
                wifiDirect = version("wifi_direct_version"),
                hotspotOta = version("hotspot_ota_version"),
            )
        }
    }
}
