import Foundation

public struct LocalMediaError: LocalizedError {
    public let message: String
    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? {
        message
    }
}

/// The glasses' DHCP server uses a /24. Never substitute an unrelated private interface.
public enum LocalMediaPolicy {
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

    /// Keep only concrete host candidates on the local link. Never rewrite a cellular socket's
    /// advertised address: a candidate must already belong to the interface it claims.
    public static func localSdp(_ sdp: String, address: String, answer: Bool) throws -> String {
        guard isPrivate(address) else { throw LocalMediaError("Invalid hotspot address") }
        var candidates = 0
        let lines = sdp.components(separatedBy: .newlines).filter { !$0.isEmpty }.filter { line in
            guard line.hasPrefix("a=candidate:") else { return true }
            let fields = line.split(separator: " ")
            guard fields.count >= 8, fields[2].lowercased() == "udp", fields[6] == "typ", fields[7] == "host" else { return false }
            let host = String(fields[4])
            guard answer ? host == address : sameSubnet(host, address) else { return false }
            candidates += 1
            return true
        }
        guard candidates > 0 else { throw LocalMediaError("No host ICE candidate on the glasses hotspot") }
        return lines.joined(separator: "\r\n") + "\r\n"
    }
}
