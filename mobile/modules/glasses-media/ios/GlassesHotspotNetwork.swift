import Darwin
import Foundation
import Network
import NetworkExtension
import OSLog

/// Same persistent hotspot join as gallery (`joinOnce=false`). Only local traffic uses Wi-Fi.
public final class GlassesHotspotNetwork {
    private let logger = Logger(subsystem: "com.mentra.glassesmedia", category: "hotspot")
    private let queue = DispatchQueue(label: "com.mentra.glassesmedia.hotspot")
    private var ssid: String?
    private var lastHotspotSSID: String?
    private var localAddress: String?
    private var gatewayAddress: String?
    private var generation = 0
    private var applying = false
    private var ownsConfiguration = false
    private var cancelled = false
    private var joinReply: ((Result<String, Error>) -> Void)?
    private var leaveReplies: [() -> Void] = []
    private var monitor: NWPathMonitor?
    #if MENTRA_E2E
        private var testLeaseConsumed = false
    #endif
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
            self.applying = false
            self.ownsConfiguration = false
            self.joinReply = completion
            if ProcessInfo.processInfo.isiOSAppOnMac {
                #if MENTRA_E2E
                    if let raw = ProcessInfo.processInfo.environment["MENTRA_E2E_PREJOINED_HOTSPOT"] {
                        let address = Self.wifiAddress()
                        guard !self.testLeaseConsumed,
                              let lease = try? JSONDecoder().decode(MacE2EHotspotLease.self, from: Data(raw.utf8)),
                              lease.matches(ssid: ssid, gateway: gateway, address: address, now: Date().timeIntervalSince1970),
                              let address
                        else {
                            self.finishJoin(.failure(LocalMediaError("Mac E2E network lease is invalid, expired or already consumed")))
                            self.finishLeave()
                            return
                        }
                        self.testLeaseConsumed = true
                        self.localAddress = address
                        self.logger.notice("HOTSPOT_JOIN test_harness_connection native_association_untested")
                        self.startMonitor(generation: gen)
                        self.finishJoin(.success(address))
                        return
                    }
                #endif
                NEHotspotNetwork.fetchCurrent { network in
                    self.queue.async {
                        guard gen == self.generation, !self.cancelled else { return }
                        let address = Self.wifiAddress()
                        if let address, LocalMediaPolicy.canReuseHotspot(requestedSSID: ssid, currentSSID: network?.ssid,
                                                                         address: address, gateway: gateway)
                        {
                            self.localAddress = address
                            self.logger.info("HOTSPOT_JOIN reuse_verified_macos_connection")
                            self.startMonitor(generation: gen)
                            self.finishJoin(.success(address))
                        } else {
                            self.applyConfiguration(ssid: ssid, passphrase: passphrase, generation: gen)
                        }
                    }
                }
            } else {
                self.applyConfiguration(ssid: ssid, passphrase: passphrase, generation: gen)
            }
            self.queue.asyncAfter(deadline: .now() + 60) {
                guard gen == self.generation, self.joinReply != nil else { return }
                self.cancelled = true
                self.finishJoin(.failure(LocalMediaError("Hotspot join timed out")))
                // apply() cannot be cancelled. Retain the reservation until its callback and remove the
                // late configuration before another call is permitted to acquire the network.
                if self.ownsConfiguration { NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid) }
                if !self.applying { self.finishLeave() }
            }
        }
    }

    public func leave(completion: @escaping () -> Void) {
        queue.async {
            self.cancelled = true
            self.leaveReplies.append(completion)
            self.finishJoin(.failure(LocalMediaError("Hotspot join cancelled")))
            if let ssid = self.ssid, self.ownsConfiguration { NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid) }
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
            if ProcessInfo.processInfo.isiOSAppOnMac {
                // The Mac route probe rejects the Wi-Fi type constraint on an otherwise
                // usable en0 route. Restrict this connection to the verified source IP.
                parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(address), port: .any)
            } else {
                parameters.requiredInterfaceType = .wifi
            }
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

    public func awaitInternet(allowWifiAfterRelease: Bool = false, completion: @escaping (Bool, String) -> Void) {
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
                if let route = HotspotInternetPolicy.route(satisfied: path.status == .satisfied,
                                                           cellular: path.usesInterfaceType(.cellular),
                                                           ethernet: path.usesInterfaceType(.wiredEthernet))
                {
                    finish(true, route)
                    return
                }
                // Once the hotspot is released, a return to the user's Wi-Fi is also valid.
                // Do not mistake the departing glasses AP's local-only path for restored internet.
                if allowWifiAfterRelease, path.status == .satisfied, path.usesInterfaceType(.wifi) {
                    NEHotspotNetwork.fetchCurrent { network in
                        self.queue.async {
                            guard let route = HotspotInternetPolicy.route(satisfied: true, cellular: false, ethernet: false,
                                                                          restoredWifiSSID: network?.ssid, glassesSSID: self.lastHotspotSSID)
                            else { return }
                            finish(true, route)
                        }
                    }
                }
            }
            monitor.start(queue: self.queue)
            self.queue.asyncAfter(deadline: .now() + 15) {
                finish(false, allowWifiAfterRelease ? "Internet did not return after leaving the glasses hotspot" : "Cellular or Ethernet internet did not become the default route")
            }
        }
    }

    private func applyConfiguration(ssid: String, passphrase: String, generation gen: Int) {
        let config = NEHotspotConfiguration(ssid: ssid, passphrase: passphrase, isWEP: false)
        config.joinOnce = false
        applying = true
        ownsConfiguration = true
        logger.info("HOTSPOT_JOIN apply_start ios_on_mac=\(ProcessInfo.processInfo.isiOSAppOnMac)")
        NEHotspotConfigurationManager.shared.apply(config) { error in
            self.queue.async {
                guard gen == self.generation else { return }
                self.applying = false
                if self.cancelled { self.finishLeave(); return }
                if let error {
                    let nativeError = error as NSError
                    let alreadyAssociated = nativeError.domain == NEHotspotConfigurationErrorDomain &&
                        nativeError.code == NEHotspotConfigurationError.alreadyAssociated.rawValue
                    if !alreadyAssociated {
                        // Error identifiers are useful without credentials or full userInfo.
                        let underlying = nativeError.userInfo[NSUnderlyingErrorKey] as? NSError
                        self.logger.error("HOTSPOT_JOIN apply_failed domain=\(nativeError.domain, privacy: .public) code=\(nativeError.code) underlying_domain=\(underlying?.domain ?? "none", privacy: .public) underlying_code=\(underlying.map { String($0.code) } ?? "none", privacy: .public)")
                        self.finishJoin(.failure(error)); self.finishLeave(); return
                    }
                }
                self.logger.info("HOTSPOT_JOIN apply_accepted")
                self.waitForAddress(ssid: ssid, generation: gen, remaining: 60)
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
            guard let self, gen == generation, !self.cancelled else { return }
            // This AP intentionally has no internet. Loss of its default internet path is not
            // loss of the local link; use the actual interface address instead.
            if Self.wifiAddress() != localAddress { onLost?("Glasses hotspot connection was lost") }
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
        if let ssid, ownsConfiguration { NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid) }
        ownsConfiguration = false
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
