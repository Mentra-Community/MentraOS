import Darwin
import Foundation

func bestLocalIPv4Address() -> String? {
    var interfaces: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&interfaces) == 0, let first = interfaces else {
        return nil
    }
    defer { freeifaddrs(interfaces) }

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
        guard ip != "127.0.0.1" else {
            continue
        }
        if name == "en0" {
            return ip
        }
        fallback = fallback ?? ip
    }

    return fallback
}
