import Foundation

/// A failure the hotspot implementation authored itself, never a native error description.
public struct HotspotError: LocalizedError {
    public let message: String
    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? {
        message
    }
}

/// The glasses' DHCP server uses a /24. Never substitute an unrelated private interface.
public enum HotspotAddressPolicy {
    public static func ipv4(_ value: String) -> [UInt8]? {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let bytes = parts.compactMap { UInt8($0) }
        return bytes.count == 4 ? bytes : nil
    }

    public static func sameSubnet(_ lhs: String, _ rhs: String) -> Bool {
        guard let a = ipv4(lhs), let b = ipv4(rhs) else { return false }
        return a.prefix(3) == b.prefix(3)
    }

    public static func isPrivate(_ address: String) -> Bool {
        guard let bytes = ipv4(address) else { return false }
        return bytes[0] == 10 || (bytes[0] == 172 && (16 ... 31).contains(bytes[1])) ||
            (bytes[0] == 192 && bytes[1] == 168)
    }

    /// SSID association can finish before DHCP replaces the previous Wi-Fi address.
    /// Accept only a client address on the /24 advertised by the glasses over BLE.
    public static func isHotspotClientAddress(_ address: String, gateway: String) -> Bool {
        guard isPrivate(gateway), sameSubnet(address, gateway), address != gateway,
              let bytes = ipv4(address) else { return false }
        return bytes[3] > 0 && bytes[3] < 255
    }

    /// A Mac may join through its host network controls. Reuse that connection only
    /// after both its SSID and DHCP address match the hotspot advertised over BLE.
    public static func canReuseHotspot(requestedSSID: String, currentSSID: String?, address: String?, gateway: String?) -> Bool {
        guard !requestedSSID.isEmpty, requestedSSID == currentSSID,
              let address, let gateway else { return false }
        return isHotspotClientAddress(address, gateway: gateway)
    }
}
