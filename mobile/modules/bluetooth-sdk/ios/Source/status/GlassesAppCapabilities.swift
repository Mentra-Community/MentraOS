import Foundation

/// What the glasses' service app supports, from the `version_info` chunk that names its package
/// (`version_info_1`). A capability that chunk doesn't name is one the app doesn't have: after an
/// update to older software the app restarts with the BLE link up, and its old capabilities must go.
struct GlassesAppCapabilities: Equatable {
    let deferredPhotos: Int
    let hotspotOta: Int

    /// Nil for a chunk that doesn't speak for the app (it doesn't name its package).
    init?(fields: [String: Any]) {
        guard fields["package_name"] != nil else { return nil }
        let version = { (key: String) in (fields[key] as? NSNumber)?.intValue ?? 0 }
        deferredPhotos = version("deferred_photos")
        hotspotOta = version("hotspot_ota_version")
    }

    init(deferredPhotos: Int, hotspotOta: Int) {
        self.deferredPhotos = deferredPhotos
        self.hotspotOta = hotspotOta
    }
}
