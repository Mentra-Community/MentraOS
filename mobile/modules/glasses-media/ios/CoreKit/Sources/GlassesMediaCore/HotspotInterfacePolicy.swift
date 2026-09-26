import Foundation

/// One IPv4 address row reported by `getifaddrs`.
public struct HotspotInterfaceAddress: Equatable {
    public let name: String
    public let isUp: Bool
    public let ipv4: String

    public init(name: String, isUp: Bool, ipv4: String) {
        self.name = name
        self.isUp = isUp
        self.ipv4 = ipv4
    }
}

/// Network framework's type for one interface on one evaluated path.
public struct HotspotInterfaceReport: Equatable {
    public let name: String
    public let isWifi: Bool

    public init(name: String, isWifi: Bool) {
        self.name = name
        self.isWifi = isWifi
    }
}

/// The Wi-Fi interface carrying the glasses hotspot and the DHCP address it held when verified.
public struct HotspotInterfaceBinding: Hashable {
    public let interface: String
    public let address: String

    public init(interface: String, address: String) {
        self.interface = interface
        self.address = address
    }
}

/// Wi-Fi is not always `en0`: a Mac can have built-in Ethernet on `en0` and Wi-Fi on `en1`.
/// Identify the hotspot link by interface type and address, never by name or by the first
/// private address, and keep that exact interface for the rest of the session.
public enum HotspotInterfacePolicy {
    /// Names that Network framework reports as Wi-Fi. A name any report classifies otherwise
    /// is conflicting evidence and is excluded.
    public static func wifiInterfaces(_ reports: [HotspotInterfaceReport]) -> Set<String> {
        let wifi = Set(reports.filter { $0.isWifi && !$0.name.isEmpty }.map(\.name))
        return wifi.subtracting(reports.filter { !$0.isWifi }.map(\.name))
    }

    /// The unique up Wi-Fi IPv4 address that can be the hotspot client. With a BLE-reported
    /// gateway it must be a valid client on that gateway's /24. Missing or ambiguous
    /// candidates return nil rather than a guess.
    public static func select(addresses: [HotspotInterfaceAddress], wifiInterfaces: Set<String>,
                              gateway: String?) -> HotspotInterfaceBinding?
    {
        let candidates = addresses.filter { row in
            guard wifiInterfaces.contains(row.name), row.isUp, LocalMediaPolicy.isPrivate(row.ipv4) else { return false }
            return gateway.map { LocalMediaPolicy.isHotspotClientAddress(row.ipv4, gateway: $0) } ?? true
        }
        let bindings = Set(candidates.map { HotspotInterfaceBinding(interface: $0.name, address: $0.ipv4) })
        return bindings.count == 1 ? bindings.first : nil
    }

    /// A verified link remains usable only while the same interface is up with the same
    /// address. Another interface acquiring that address, or a later report that the
    /// interface is not Wi-Fi, does not keep it alive.
    public static func isIntact(_ binding: HotspotInterfaceBinding, addresses: [HotspotInterfaceAddress],
                                reports: [HotspotInterfaceReport]) -> Bool
    {
        guard !reports.contains(where: { $0.name == binding.interface && !$0.isWifi }) else { return false }
        return addresses.contains { $0.name == binding.interface && $0.isUp && $0.ipv4 == binding.address }
    }
}
