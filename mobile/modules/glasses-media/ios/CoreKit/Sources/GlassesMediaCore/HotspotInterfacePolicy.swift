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

/// One `getifaddrs` sample: every attached interface's kernel index (its `AF_LINK` row, present
/// with or without an IPv4 address) and every IPv4 address row.
public struct HotspotInterfaceSnapshot: Equatable {
    public let links: [String: Int]
    public let addresses: [HotspotInterfaceAddress]

    public init(links: [String: Int], addresses: [HotspotInterfaceAddress]) {
        self.links = links
        self.addresses = addresses
    }
}

/// Network framework's type for one interface on one evaluated path.
public struct HotspotInterfaceReport: Equatable {
    public let name: String
    public let index: Int
    public let isWifi: Bool

    public init(name: String, index: Int, isWifi: Bool) {
        self.name = name
        self.index = index
        self.isWifi = isWifi
    }
}

/// The Wi-Fi interface carrying the glasses hotspot and the DHCP address it held when verified.
public struct HotspotInterfaceBinding: Hashable {
    public let interface: String
    public let index: Int
    public let address: String

    public init(interface: String, index: Int, address: String) {
        self.interface = interface
        self.index = index
        self.address = address
    }
}

/// Wi-Fi identity learned during one hotspot session. Create a new value for every join.
///
/// A path's interface list describes routes, not hardware: after Wi-Fi moves to an AP without
/// internet, both the default and the Wi-Fi-constrained path can omit it. An interface's type
/// does not change while it stays attached, so a positive Wi-Fi report is kept for the same
/// name and kernel index until that interface is detached or replaced. Omission from a later
/// report is not evidence. Any non-Wi-Fi report for a name rejects it for the rest of the session.
public struct HotspotWifiIdentity: Equatable {
    public private(set) var trusted: [String: Int] = [:]
    public private(set) var rejected: Set<String> = []
    /// Trusted names later seen detached or replaced. A fresh report may trust the name again
    /// for discovery, but an address verified before the change stays lost.
    public private(set) var detached: Set<String> = []

    public init() {}

    public mutating func observe(_ reports: [HotspotInterfaceReport]) {
        for report in reports where !report.isWifi {
            rejected.insert(report.name)
            trusted[report.name] = nil
        }
        for report in reports where report.isWifi && !report.name.isEmpty && report.index > 0 && !rejected.contains(report.name) {
            // A new index means a different interface took the name; only this report vouches for it.
            if let index = trusted[report.name], index != report.index { detached.insert(report.name) }
            trusted[report.name] = report.index
        }
    }

    /// Forget an interface that is no longer attached, or whose name now has another index.
    /// Only a new positive report can re-establish it.
    public mutating func observe(_ snapshot: HotspotInterfaceSnapshot) {
        for (name, index) in trusted where snapshot.links[name] != index {
            trusted[name] = nil
            detached.insert(name)
        }
    }
}

/// Wi-Fi is not always `en0`: a Mac can have built-in Ethernet on `en0` and Wi-Fi on `en1`.
/// Identify the hotspot link by interface type and address, never by name or by the first
/// private address, and keep that exact interface for the rest of the session.
public enum HotspotInterfacePolicy {
    /// The unique up IPv4 address, on an interface this session trusts as Wi-Fi and that is still
    /// attached with the same index, that can be the hotspot client. With a BLE-reported gateway
    /// it must be a valid client on that gateway's /24. Missing or ambiguous candidates return nil.
    public static func select(snapshot: HotspotInterfaceSnapshot, identity: HotspotWifiIdentity,
                              gateway: String?) -> HotspotInterfaceBinding?
    {
        let bindings = Set(snapshot.addresses.compactMap { row -> HotspotInterfaceBinding? in
            guard let index = identity.trusted[row.name], snapshot.links[row.name] == index,
                  row.isUp, LocalMediaPolicy.isPrivate(row.ipv4) else { return nil }
            if let gateway, !LocalMediaPolicy.isHotspotClientAddress(row.ipv4, gateway: gateway) { return nil }
            return HotspotInterfaceBinding(interface: row.name, index: index, address: row.ipv4)
        })
        return bindings.count == 1 ? bindings.first : nil
    }

    /// A verified link remains usable only while the same attached interface is up with the same
    /// address. Later path reports may omit it. Another interface acquiring that address, a
    /// detach or replacement under the same name, or a non-Wi-Fi report ends it for the session.
    /// Pass an identity that has already observed `snapshot`.
    public static func isIntact(_ binding: HotspotInterfaceBinding, snapshot: HotspotInterfaceSnapshot,
                                identity: HotspotWifiIdentity) -> Bool
    {
        guard identity.trusted[binding.interface] == binding.index, !identity.detached.contains(binding.interface),
              snapshot.links[binding.interface] == binding.index else { return false }
        return snapshot.addresses.contains { $0.name == binding.interface && $0.isUp && $0.ipv4 == binding.address }
    }
}
