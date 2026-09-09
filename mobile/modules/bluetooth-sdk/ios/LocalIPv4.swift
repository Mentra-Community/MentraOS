import Darwin
import Foundation

/// Best-effort local IPv4 discovery for phone-hosted servers the glasses reach over WiFi
/// (photo upload receiver, hotspot-served OTA). Prefers WiFi-ish interfaces carrying RFC1918
/// addresses — under a glasses-hotspot session en0 holds the 192.168.43.x client address.
enum LocalIPv4 {
    /// Return the active Wi-Fi address only when it is on the glasses gateway's /24.
    /// iPhone Wi-Fi is `en0`; accepting AWDL, VPN, cellular, or another private
    /// interface can publish an endpoint that the glasses cannot reach.
    static func wifiIPv4Address(matchingGateway gateway: String) -> String? {
        guard let gatewayPrefix = subnet24Prefix(gateway) else {
            return nil
        }

        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0, let first = interfaces else {
            return nil
        }
        defer { freeifaddrs(interfaces) }

        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let current = cursor {
            defer { cursor = current.pointee.ifa_next }
            let interface = current.pointee
            guard String(cString: interface.ifa_name) == "en0",
                  let addressPointer = interface.ifa_addr,
                  addressPointer.pointee.sa_family == UInt8(AF_INET),
                  (interface.ifa_flags & UInt32(IFF_UP)) != 0
            else {
                continue
            }

            var address = addressPointer.pointee
            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(
                &address,
                socklen_t(address.sa_len),
                &hostname,
                socklen_t(hostname.count),
                nil,
                0,
                NI_NUMERICHOST
            ) == 0 else {
                continue
            }

            let ip = String(cString: hostname)
            if subnet24Prefix(ip) == gatewayPrefix {
                return ip
            }
        }
        return nil
    }

    static func bestLocalIPv4Address() -> String? {
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0, let first = interfaces else {
            return nil
        }
        defer { freeifaddrs(interfaces) }

        var preferredPrivate: String?
        var preferred: String?
        var privateFallback: String?
        var fallback: String?
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let current = cursor {
            defer { cursor = current.pointee.ifa_next }
            let interface = current.pointee
            guard let addressPointer = interface.ifa_addr,
                  addressPointer.pointee.sa_family == UInt8(AF_INET)
            else {
                continue
            }

            let name = String(cString: interface.ifa_name)
            let flags = interface.ifa_flags
            guard (flags & UInt32(IFF_UP)) != 0,
                  (flags & UInt32(IFF_LOOPBACK)) == 0
            else {
                continue
            }

            var address = addressPointer.pointee
            var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                &address,
                socklen_t(address.sa_len),
                &hostname,
                socklen_t(hostname.count),
                nil,
                0,
                NI_NUMERICHOST
            )
            guard result == 0 else {
                continue
            }

            let ip = String(cString: hostname)
            guard ip != "127.0.0.1", !isLinkLocalIPv4(ip) else {
                continue
            }
            if isPreferredLocalInterface(name), isPrivateIPv4(ip) {
                preferredPrivate = preferredPrivate ?? ip
            } else if isPreferredLocalInterface(name) {
                preferred = preferred ?? ip
            } else if isPrivateIPv4(ip) {
                privateFallback = privateFallback ?? ip
            } else {
                fallback = fallback ?? ip
            }
        }

        return preferredPrivate ?? preferred ?? privateFallback ?? fallback
    }

    private static func isPreferredLocalInterface(_ name: String) -> Bool {
        name == "en0" ||
            name.hasPrefix("bridge") ||
            name.hasPrefix("ap") ||
            name.hasPrefix("awdl") ||
            name.hasPrefix("llw")
    }

    private static func isPrivateIPv4(_ ip: String) -> Bool {
        if ip.hasPrefix("192.168.") || ip.hasPrefix("10.") {
            return true
        }
        let parts = ip.split(separator: ".").compactMap { Int($0) }
        return parts.count == 4 && parts[0] == 172 && (16 ... 31).contains(parts[1])
    }

    private static func isLinkLocalIPv4(_ ip: String) -> Bool {
        ip.hasPrefix("169.254.")
    }

    private static func subnet24Prefix(_ ip: String) -> String? {
        let parts = ip.split(separator: ".")
        guard parts.count == 4,
              parts.allSatisfy({ part in
                  guard let value = Int(part) else { return false }
                  return (0 ... 255).contains(value)
              })
        else {
            return nil
        }
        return parts.prefix(3).joined(separator: ".")
    }
}
