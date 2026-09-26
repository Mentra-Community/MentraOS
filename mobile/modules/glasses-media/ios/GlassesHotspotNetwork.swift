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
    /// The verified Wi-Fi interface and DHCP address. Every later check uses this exact pair.
    private var binding: HotspotInterfaceBinding?
    private var gatewayAddress: String?
    private var generation = 0
    private var applying = false
    private var ownsConfiguration = false
    private var cancelled = false
    private var joinReply: ((Result<String, Error>) -> Void)?
    private var leaveReplies: [() -> Void] = []
    private var interfaceMonitors: [NWPathMonitor] = []
    private var interfaceReports: [[HotspotInterfaceReport]?] = []
    private var interfaceReportsReady: (() -> Void)?
    private var localAccess: LocalNetworkAccessRequest?
    private var localAddress: String? { binding?.address }
    #if MENTRA_E2E
        private var testLeaseConsumed = false
    #endif
    public var onLost: ((String) -> Void)?
    public var onPermissionRequired: (() -> Void)?
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
            self.startInterfaceMonitors(generation: gen)
            if ProcessInfo.processInfo.isiOSAppOnMac {
                // Reuse is decided once, so it needs the interface types first.
                self.awaitInterfaceReports(generation: gen) {
                    #if MENTRA_E2E
                        if let raw = ProcessInfo.processInfo.environment["MENTRA_E2E_PREJOINED_HOTSPOT"] {
                            let selected = self.selectBinding()
                            guard !self.testLeaseConsumed,
                                  let lease = try? JSONDecoder().decode(MacE2EHotspotLease.self, from: Data(raw.utf8)),
                                  lease.matches(ssid: ssid, gateway: gateway, address: selected?.address, now: Date().timeIntervalSince1970),
                                  let selected
                            else {
                                self.finishJoin(.failure(LocalMediaError("Mac E2E network lease is invalid, expired or already consumed")))
                                self.finishLeave()
                                return
                            }
                            self.testLeaseConsumed = true
                            self.bind(selected)
                            self.logger.notice("HOTSPOT_JOIN test_harness_connection native_association_untested")
                            self.waitForLocalAccess(address: selected.address, generation: gen)
                            return
                        }
                    #endif
                    NEHotspotNetwork.fetchCurrent { network in
                        self.queue.async {
                            guard gen == self.generation, !self.cancelled else { return }
                            let selected = self.selectBinding()
                            if let selected, LocalMediaPolicy.canReuseHotspot(requestedSSID: ssid, currentSSID: network?.ssid,
                                                                              address: selected.address, gateway: gateway)
                            {
                                self.bind(selected)
                                self.logger.info("HOTSPOT_JOIN reuse_verified_macos_connection")
                                self.waitForLocalAccess(address: selected.address, generation: gen)
                            } else {
                                self.applyConfiguration(ssid: ssid, passphrase: passphrase, generation: gen)
                            }
                        }
                    }
                }
            } else {
                self.applyConfiguration(ssid: ssid, passphrase: passphrase, generation: gen)
            }
            self.queue.asyncAfter(deadline: .now() + 60) {
                // Once associated, the user may still be reading the Local Network alert.
                // Its response time is not a hotspot association timeout.
                guard gen == self.generation, self.joinReply != nil, self.localAccess == nil else { return }
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

    /// The verified hotspot address while its own Wi-Fi interface still holds it; nil after
    /// loss, leave or an address change. Never falls back to another interface.
    public func verifiedAddress(completion: @escaping (String?) -> Void) {
        queue.async {
            guard let binding = self.binding, !self.cancelled, self.isBindingIntact(binding) else { completion(nil); return }
            completion(binding.address)
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
                // usable hotspot route. Restrict this connection to the verified source IP.
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
                // The selection applies the BLE gateway's client check when one was reported.
                if network?.ssid == ssid, let selected = self.selectBinding() {
                    self.bind(selected)
                    self.waitForLocalAccess(address: selected.address, generation: gen)
                } else if remaining > 0 {
                    self.queue.asyncAfter(deadline: .now() + 0.5) { self.waitForAddress(ssid: ssid, generation: gen, remaining: remaining - 1) }
                } else {
                    let association = network == nil ? "unavailable" : (network?.ssid == ssid ? "matched" : "different")
                    self.finishJoin(.failure(LocalMediaError("Glasses hotspot has no verified Wi-Fi address (SSID=\(association), \(self.wifiDiagnostic()))")))
                    self.finishLeave()
                }
            }
        }
    }

    /// iOS can omit an internet-less Wi-Fi from its default path, and iOS-on-Mac has rejected
    /// a Wi-Fi type constraint on a usable hotspot route. Keep both paths' interface types;
    /// HotspotInterfacePolicy fails closed when they are missing or conflict.
    private func startInterfaceMonitors(generation gen: Int) {
        interfaceMonitors.forEach { $0.cancel() }
        let monitors = [NWPathMonitor(requiredInterfaceType: .wifi), NWPathMonitor()]
        interfaceMonitors = monitors
        interfaceReports = Array(repeating: nil, count: monitors.count)
        for (index, monitor) in monitors.enumerated() {
            monitor.pathUpdateHandler = { [weak self] path in
                guard let self, gen == self.generation else { return }
                self.interfaceReports[index] = path.availableInterfaces.map { HotspotInterfaceReport(name: $0.name, isWifi: $0.type == .wifi) }
                if self.interfaceReports.allSatisfy({ $0 != nil }) { self.fireInterfaceReportsReady() }
                // This AP intentionally has no internet. Loss of its default internet path is not
                // loss of the local link; check the verified interface and address instead.
                if let binding = self.binding, !self.cancelled, !self.isBindingIntact(binding) {
                    self.onLost?("Glasses hotspot connection was lost")
                }
            }
            monitor.start(queue: queue)
        }
    }

    /// Continue once every monitor has reported, or after a short bound with whatever arrived.
    private func awaitInterfaceReports(generation gen: Int, then proceed: @escaping () -> Void) {
        interfaceReportsReady = { [weak self] in
            guard let self, gen == self.generation, !self.cancelled else { return }
            proceed()
        }
        if interfaceReports.allSatisfy({ $0 != nil }) { fireInterfaceReportsReady(); return }
        queue.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, gen == self.generation else { return }
            self.fireInterfaceReportsReady()
        }
    }

    private func fireInterfaceReportsReady() {
        let ready = interfaceReportsReady
        interfaceReportsReady = nil
        ready?()
    }

    private var currentReports: [HotspotInterfaceReport] {
        interfaceReports.compactMap { $0 }.flatMap { $0 }
    }

    private func selectBinding() -> HotspotInterfaceBinding? {
        HotspotInterfacePolicy.select(addresses: Self.interfaceAddresses(),
                                      wifiInterfaces: HotspotInterfacePolicy.wifiInterfaces(currentReports),
                                      gateway: gatewayAddress)
    }

    private func isBindingIntact(_ binding: HotspotInterfaceBinding) -> Bool {
        HotspotInterfacePolicy.isIntact(binding, addresses: Self.interfaceAddresses(), reports: currentReports)
    }

    private func bind(_ selected: HotspotInterfaceBinding) {
        binding = selected
        logger.info("HOTSPOT_JOIN address_verified interface=\(selected.interface, privacy: .public)")
    }

    /// Interface names and their IPv4 addresses only; never credentials or SSIDs.
    private func wifiDiagnostic() -> String {
        let wifi = HotspotInterfacePolicy.wifiInterfaces(currentReports)
        let addresses = Self.interfaceAddresses().filter { wifi.contains($0.name) }.map { "\($0.name)=\($0.ipv4)" }
        return "Wi-Fi interfaces=\(wifi.isEmpty ? "none" : wifi.sorted().joined(separator: ",")), " +
            "Wi-Fi IPv4=\(addresses.isEmpty ? "none" : addresses.sorted().joined(separator: ","))"
    }

    private func waitForLocalAccess(address: String, generation gen: Int) {
        let gateway = gatewayAddress ?? address.split(separator: ".").prefix(3).joined(separator: ".") + ".1"
        let request = LocalNetworkAccessRequest(localAddress: address, gateway: gateway, queue: queue)
        localAccess = request
        request.start(onPermissionRequired: { [weak self] in
            guard let self, gen == generation, !cancelled else { return }
            NSLog("GLASSES-MEDIA local_network_permission=waiting")
            onPermissionRequired?()
        }) { [weak self] result in
            guard let self, gen == generation, !cancelled else { return }
            switch result {
            case .success:
                NSLog("GLASSES-MEDIA local_network_permission=ready")
                finishJoin(.success(address))
            case let .failure(error):
                finishJoin(.failure(error))
                finishLeave()
            }
        }
    }

    private func finishJoin(_ result: Result<String, Error>) {
        let reply = joinReply
        joinReply = nil
        reply?(result)
    }

    private func finishLeave() {
        generation += 1
        localAccess?.cancel(); localAccess = nil
        interfaceMonitors.forEach { $0.cancel() }
        interfaceMonitors = []
        interfaceReports = []
        interfaceReportsReady = nil
        if let ssid, ownsConfiguration { NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid) }
        ownsConfiguration = false
        ssid = nil
        binding = nil
        gatewayAddress = nil
        let replies = leaveReplies
        leaveReplies.removeAll()
        replies.forEach { $0() }
    }

    /// Every IPv4 address with its interface name and up state. Selection belongs to
    /// HotspotInterfacePolicy; an interface name alone never identifies Wi-Fi.
    static func interfaceAddresses() -> [HotspotInterfaceAddress] {
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0 else { return [] }
        defer { freeifaddrs(interfaces) }
        var rows: [HotspotInterfaceAddress] = []
        var cursor = interfaces
        while let item = cursor {
            defer { cursor = item.pointee.ifa_next }
            let value = item.pointee
            guard let address = value.ifa_addr, address.pointee.sa_family == UInt8(AF_INET) else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            rows.append(HotspotInterfaceAddress(name: String(cString: value.ifa_name),
                                                isUp: value.ifa_flags & UInt32(IFF_UP) != 0, ipv4: String(cString: host)))
        }
        return rows
    }
}
