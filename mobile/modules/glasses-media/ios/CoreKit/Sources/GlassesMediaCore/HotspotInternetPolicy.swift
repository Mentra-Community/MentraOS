/// A usable default route is independent of the glasses' local-only Wi-Fi hotspot.
/// This classifies network paths; actual server reachability is established by the call.
public enum HotspotInternetPolicy {
    public static func route(satisfied: Bool, cellular: Bool, ethernet: Bool,
                             restoredWifiSSID: String? = nil, glassesSSID: String? = nil) -> String?
    {
        guard satisfied else { return nil }
        if cellular { return "cellular" }
        if ethernet { return "ethernet" }
        // Callers supply a Wi-Fi SSID only after releasing the glasses hotspot.
        if let restoredWifiSSID, !restoredWifiSSID.isEmpty, restoredWifiSSID != glassesSSID {
            return "wifi"
        }
        return nil
    }
}
