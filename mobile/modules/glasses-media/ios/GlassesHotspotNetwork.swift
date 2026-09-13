import Darwin
import Foundation
import Network
import NetworkExtension

/// Same persistent hotspot join as gallery (`joinOnce=false`). Only local traffic uses Wi-Fi.
public final class GlassesHotspotNetwork {
    private let queue = DispatchQueue(label: "com.mentra.glassesmedia.hotspot")
    private var ssid: String?
    private var lastHotspotSSID: String?
    private var localAddress: String?
    private var gatewayAddress: String?
    private var generation = 0
    private var applying = false
    private var cancelled = false
    private var joinReply: ((Result<String, Error>) -> Void)?
    private var leaveReplies: [() -> Void] = []
    private var monitor: NWPathMonitor?
    public var onLost: ((String) -> Void)?
    public init() {}

    public func join(ssid: String, passphrase: String, gateway: String? = nil, completion: @escaping (Result<String, Error>) -> Void) {
        queue.async {
            guard self.ssid == nil, !self.applying else { completion(.failure(LocalMediaError("Previous hotspot session has not finished cleaning up"))); return }
            if let gateway, !LocalMediaPolicy.isPrivate(gateway) {
                completion(.failure(LocalMediaError("The glasses reported an invalid hotspot gateway"))); return
            }
            self.generation += 1
            let gen = self.generation
            self.ssid = ssid
            self.lastHotspotSSID = ssid
            self.gatewayAddress = gateway
            self.cancelled = false
            self.applying = true
            self.joinReply = completion
            let config = NEHotspotConfiguration(ssid: ssid, passphrase: passphrase, isWEP: false)
            config.joinOnce = false
            NEHotspotConfigurationManager.shared.apply(config) { error in
                self.queue.async {
                    guard gen == self.generation else { return }
                    self.applying = false
                    if self.cancelled { self.finishLeave(); return }
                    if let error, (error as NSError).code != NEHotspotConfigurationError.alreadyAssociated.rawValue {
                        self.finishJoin(.failure(error)); self.finishLeave(); return
                    }
                    self.waitForAddress(ssid: ssid, generation: gen, remaining: 60)
                }
            }
            self.queue.asyncAfter(deadline: .now() + 60) {
                guard gen == self.generation, self.joinReply != nil else { return }
                self.cancelled = true
                self.finishJoin(.failure(LocalMediaError("Hotspot join timed out")))
                // apply() cannot be cancelled. Retain the reservation until its callback and remove the
                // late configuration before another call is permitted to acquire the network.
                NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid)
                if !self.applying { self.finishLeave() }
            }
        }
    }

    public func leave(completion: @escaping () -> Void) {
        queue.async {
            self.cancelled = true
            self.leaveReplies.append(completion)
            self.finishJoin(.failure(LocalMediaError("Hotspot join cancelled")))
            if let ssid = self.ssid { NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid) }
            if !self.applying { self.finishLeave() }
        }
    }

    public func info(completion: @escaping ([String: Any]) -> Void) {
        queue.async {
            var value: [String: Any] = ["available": self.localAddress != nil]
            if let address = self.localAddress {
                value["localIpv4"] = address
                value["prefix"] = address.split(separator: ".").prefix(3).joined(separator: ".") + ".0/24"
            }
            completion(value)
        }
    }

    public func probeGateway(completion: @escaping (Bool, String) -> Void) {
        queue.async {
            guard let address = self.localAddress else { completion(false, "No joined hotspot"); return }
            let gateway = self.gatewayAddress ?? address.split(separator: ".").prefix(3).joined(separator: ".") + ".1"
            let parameters = NWParameters.tcp
            parameters.requiredInterfaceType = .wifi
            let connection = NWConnection(host: NWEndpoint.Host(gateway), port: 8089, using: parameters)
            var finished = false
            let finish: (Bool, String) -> Void = { reachable, detail in
                guard !finished else { return }
                finished = true
                connection.stateUpdateHandler = nil
                connection.cancel()
                completion(reachable, detail)
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready: finish(true, "\(gateway):8089")
                case let .failed(error): finish(false, error.localizedDescription)
                default: break
                }
            }
            connection.start(queue: self.queue)
            self.queue.asyncAfter(deadline: .now() + 3) { finish(false, "Gateway probe timed out") }
        }
    }

    public func awaitInternet(requireCellular: Bool = true, completion: @escaping (Bool, String) -> Void) {
        queue.async {
            let monitor = NWPathMonitor()
            var finished = false
            let finish: (Bool, String) -> Void = { usable, detail in
                guard !finished else { return }
                finished = true
                monitor.cancel()
                completion(usable, detail)
            }
            monitor.pathUpdateHandler = { path in
                if path.status == .satisfied, path.usesInterfaceType(.cellular) { finish(true, "cellular") }
                // Once the hotspot is released, a return to the user's Wi-Fi is also valid.
                // Do not mistake the departing glasses AP's local-only path for restored internet.
                if !requireCellular, path.status == .satisfied, path.usesInterfaceType(.wifi) {
                    NEHotspotNetwork.fetchCurrent { network in
                        self.queue.async {
                            guard let network, network.ssid != self.lastHotspotSSID else { return }
                            finish(true, "wifi")
                        }
                    }
                }
            }
            monitor.start(queue: self.queue)
            self.queue.asyncAfter(deadline: .now() + 15) {
                finish(false, requireCellular ? "Cellular internet did not become the default route" : "Internet did not return after leaving the glasses hotspot")
            }
        }
    }

    private func waitForAddress(ssid: String, generation gen: Int, remaining: Int) {
        guard gen == generation, !cancelled else { return }
        NEHotspotNetwork.fetchCurrent { [weak self] network in
            self?.queue.async {
                guard let self, gen == self.generation, !self.cancelled else { return }
                if network?.ssid == ssid, let address = Self.wifiAddress(),
                   self.gatewayAddress.map({ LocalMediaPolicy.isHotspotClientAddress(address, gateway: $0) }) ?? true
                {
                    self.localAddress = address
                    self.startMonitor(generation: gen)
                    self.finishJoin(.success(address))
                } else if remaining > 0 {
                    self.queue.asyncAfter(deadline: .now() + 0.5) { self.waitForAddress(ssid: ssid, generation: gen, remaining: remaining - 1) }
                } else {
                    let association = network == nil ? "unavailable" : (network?.ssid == ssid ? "matched" : "different")
                    let address = Self.wifiAddress() ?? "none"
                    self.finishJoin(.failure(LocalMediaError("Glasses hotspot has no verified Wi-Fi address (SSID=\(association), Wi-Fi IPv4=\(address))")))
                    self.finishLeave()
                }
            }
        }
    }

    private func startMonitor(generation gen: Int) {
        let monitor = NWPathMonitor(requiredInterfaceType: .wifi)
        self.monitor = monitor
        monitor.pathUpdateHandler = { [weak self] _ in
            guard let self, gen == self.generation, !self.cancelled else { return }
            // This AP intentionally has no internet. Loss of its default internet path is not
            // loss of the local link; use the actual interface address instead.
            if Self.wifiAddress() != self.localAddress { self.onLost?("Glasses hotspot connection was lost") }
        }
        monitor.start(queue: queue)
    }

    private func finishJoin(_ result: Result<String, Error>) {
        let reply = joinReply
        joinReply = nil
        reply?(result)
    }

    private func finishLeave() {
        generation += 1
        monitor?.cancel(); monitor = nil
        if let ssid { NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid) }
        ssid = nil
        localAddress = nil
        gatewayAddress = nil
        let replies = leaveReplies
        leaveReplies.removeAll()
        replies.forEach { $0() }
    }

    public static func wifiAddress() -> String? {
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0 else { return nil }
        defer { freeifaddrs(interfaces) }
        var cursor = interfaces
        while let item = cursor {
            defer { cursor = item.pointee.ifa_next }
            let value = item.pointee
            guard String(cString: value.ifa_name) == "en0", value.ifa_flags & UInt32(IFF_UP) != 0,
                  let address = value.ifa_addr, address.pointee.sa_family == UInt8(AF_INET) else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let ip = String(cString: host)
            if LocalMediaPolicy.isPrivate(ip) { return ip }
        }
        return nil
    }
}
