import Darwin
import Foundation
import Network
import NetworkExtension
import OSLog

/// Shared hotspot association owner. Only local glasses traffic uses Wi-Fi.
public final class GlassesHotspotNetwork {
    private let logger = Logger(subsystem: "com.mentra.glassesmedia", category: "hotspot")
    private let queue = DispatchQueue(label: "com.mentra.glassesmedia.hotspot")
    private var ssid: String?
    private var lastHotspotSSID: String?
    /// The verified Wi-Fi interface and DHCP address. Every later check uses this exact pair.
    private var binding: HotspotInterfaceBinding?
    private var accessPurpose: HotspotAccessPurpose = .outgoingClient
    private var gatewayAddress: String?
    private var generation = 0
    private var applying = false
    private var ownsConfiguration = false
    private var applies = 0
    private let reapplyPolicy = HotspotReapplyPolicy()
    private var cancelled = false
    private var joinReply: ((Result<String, Error>) -> Void)?
    private var leaveCompletion: HotspotLeaveCompletion?
    private var interfaceMonitors: [NWPathMonitor] = []
    /// Wi-Fi identity learned since this join started; replaced on every join and cleared on leave.
    private var wifiIdentity = HotspotWifiIdentity()
    private var localAccess: LocalNetworkAccessRequest?
    private var localAddress: String? {
        binding?.address
    }

    private let macWorker = DispatchQueue(label: "com.mentra.glassesmedia.mac-wifi")
    private var macAssociation: MacHotspotAssociation?
    private var macAuthorization: MacHotspotAuthorization?
    private var macCleanupContinuation: MacHotspotCleanupContinuation?
    private var ownershipToken: UUID?
    private var finishingLeave = false
    private var waitForInternetAfterLeave = false
    private let internetObservationOwner = HotspotInternetObservationOwner()
    public var onLost: ((String) -> Void)?
    public var onPermissionRequired: (() -> Void)?
    public init() {}

    public func join(ssid: String, passphrase: String, gateway: String? = nil, purpose: HotspotAccessPurpose = .outgoingClient, completion: @escaping (Result<String, Error>) -> Void) {
        queue.async {
            guard self.ssid == nil, !self.applying else { completion(.failure(LocalMediaError("Previous hotspot session has not finished cleaning up"))); return }
            if let gateway, !LocalMediaPolicy.isPrivate(gateway) {
                completion(.failure(LocalMediaError("The glasses reported an invalid hotspot gateway"))); return
            }
            if ProcessInfo.processInfo.isiOSAppOnMac, gateway == nil {
                completion(.failure(LocalMediaError("The glasses did not report their hotspot gateway"))); return
            }
            guard let token = HotspotNetworkOwnership.shared.acquire() else {
                completion(.failure(LocalMediaError("The glasses hotspot is already in use"))); return
            }
            self.ownershipToken = token
            self.generation += 1
            let gen = self.generation
            let deadline = ProcessInfo.processInfo.systemUptime + 60
            self.ssid = ssid
            self.lastHotspotSSID = ssid
            self.gatewayAddress = gateway
            self.accessPurpose = purpose
            self.cancelled = false
            self.applying = false
            self.ownsConfiguration = false
            self.applies = 0
            self.joinReply = completion
            self.startInterfaceMonitors(generation: gen)
            if ProcessInfo.processInfo.isiOSAppOnMac {
                self.authorizeMacAssociation(ssid: ssid, passphrase: passphrase, generation: gen, deadline: deadline)
            } else {
                self.applyConfiguration(ssid: ssid, passphrase: passphrase, generation: gen)
            }
            self.queue.asyncAfter(deadline: .now() + max(0, deadline - ProcessInfo.processInfo.systemUptime)) {
                // Once associated, the user may still be reading the Local Network alert.
                // Its response time is not a hotspot association timeout.
                guard gen == self.generation, self.joinReply != nil, self.localAccess == nil else { return }
                self.cancelled = true
                self.macAssociation?.cancel()
                self.macAuthorization?.cancelPending()
                self.finishJoin(.failure(LocalMediaError("Hotspot join timed out")))
                // apply() cannot be cancelled. Retain the reservation until its callback and remove the
                // late configuration before another call is permitted to acquire the network.
                if self.ownsConfiguration { NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid) }
                if !self.applying { self.finishLeave() }
            }
        }
    }

    public func leave(waitForInternet: Bool = false, completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            if !waitForInternet { self.internetObservationOwner.cancel() }
            self.waitForInternetAfterLeave = self.waitForInternetAfterLeave || waitForInternet
            self.cancelled = true
            self.macAssociation?.cancel()
            self.macAuthorization?.cancelPending()
            if self.leaveCompletion == nil {
                self.leaveCompletion = HotspotLeaveCompletion {
                    if let token = self.ownershipToken { HotspotNetworkOwnership.shared.release(token) }
                    self.ownershipToken = nil
                }
            }
            self.leaveCompletion?.append(completion)
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
            if let association = self.macAssociation {
                let ssid = self.ssid
                let gen = self.generation
                self.macWorker.async {
                    let matched = (try? association.currentSSID()) == ssid
                    self.queue.async {
                        completion(gen == self.generation && !self.cancelled && matched && self.isBindingIntact(binding) ? binding.address : nil)
                    }
                }
            } else { completion(binding.address) }
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
        queue.async { self.startInternetObservation(allowWifiAfterRelease: allowWifiAfterRelease, completion: completion) }
    }

    /// Called on the owner queue, including directly from completeLeave. A queued
    /// cancellation therefore cannot overtake observation initialization.
    private func startInternetObservation(allowWifiAfterRelease: Bool, completion: @escaping (Bool, String) -> Void) {
        let gen = generation
        let observation = HotspotInternetObservation(generation: gen, glassesSSID: lastHotspotSSID)
        let monitor = NWPathMonitor()
        let sampleTimer = DispatchSource.makeTimerSource(queue: queue)
        var currentPath: Network.NWPath?
        let finish: (Bool, String) -> Void = { usable, detail in
            guard observation.settle() else { return }
            monitor.pathUpdateHandler = nil
            monitor.cancel()
            sampleTimer.setEventHandler {}
            sampleTimer.cancel()
            currentPath = nil
            let reply = {
                self.internetObservationOwner.clear(observation)
                completion(usable, detail)
            }
            // Even a timed-out/cancelled observation joins its dispatched
            // CoreWLAN read before releasing this session's owner.
            observation.afterSSIDRead(reply)
        }
        internetObservationOwner.install(observation) { finish(false, "Hotspot internet observation cancelled") }
        var currentPathRevision = 0
        let sample = {
            guard let path = currentPath else { return }
            if let route = HotspotInternetPolicy.route(satisfied: path.status == .satisfied,
                                                       cellular: path.usesInterfaceType(.cellular),
                                                       ethernet: path.usesInterfaceType(.wiredEthernet))
            {
                finish(true, route)
                return
            }
            // Sample returned membership while the route remains on Wi-Fi;
            // NWPath need not report a new interface when the SSID changes.
            guard allowWifiAfterRelease, path.status == .satisfied,
                  path.usesInterfaceType(.wifi), observation.beginSSIDRead() else { return }
            let pathRevision = currentPathRevision
            let observed: (String?) -> Void = { ssid in
                self.queue.async {
                    observation.completeSSIDRead()
                    guard gen == self.generation else { finish(false, "Hotspot session changed"); return }
                    guard let route = observation.restoredWifiRoute(ssid: ssid, pathRevision: pathRevision, currentGeneration: self.generation)
                    else { return }
                    finish(true, route)
                }
            }
            if ProcessInfo.processInfo.isiOSAppOnMac {
                self.macWorker.async { observed(try? MacHotspotAssociation.observeCurrentSSID()) }
            } else { NEHotspotNetwork.fetchCurrent { observed($0?.ssid) } }
        }
        monitor.pathUpdateHandler = { path in
            guard let pathRevision = observation.beginPath(currentGeneration: self.generation) else { finish(false, "Hotspot session changed"); return }
            currentPath = path
            currentPathRevision = pathRevision
            sample()
        }
        sampleTimer.setEventHandler(handler: sample)
        sampleTimer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        sampleTimer.resume()
        monitor.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 15) {
            finish(false, allowWifiAfterRelease ? "Internet did not return after leaving the glasses hotspot" : "Cellular or Ethernet internet did not become the default route")
        }
    }

    private func authorizeMacAssociation(ssid: String, passphrase: String, generation gen: Int, deadline: TimeInterval) {
        let facts = MacHotspotAuthorizationFacts()
        let authorization = MacHotspotAuthorization(facts: facts)
        macAuthorization = authorization
        authorization.onRevoked = { [weak self] error in
            guard let self else { return }
            self.queue.async {
                guard gen == self.generation, !self.cancelled else { return }
                self.cancelled = true
                self.macAssociation?.cancel()
                self.finishJoin(.failure(error))
                self.onLost?("Glasses hotspot Location authorization was revoked")
                if !self.applying { self.finishLeave() }
            }
        }
        macCleanupContinuation = MacHotspotCleanupContinuation(authorization: authorization, queue: queue,
                                                               isCurrentCancelledSession: { [weak self] in
                                                                   guard let self else { return false }
                                                                   return gen == self.generation && self.cancelled
                                                               }, requestCleanup: { [weak self] in
                                                                   guard let self, !self.applying else { return }
                                                                   self.finishLeave()
                                                               })
        authorization.start { result in
            self.queue.async {
                guard gen == self.generation, !self.cancelled else { return }
                switch result {
                case .success: self.applyMacAssociation(ssid: ssid, passphrase: passphrase, generation: gen, deadline: deadline, authorizationFacts: facts, authorization: authorization)
                case let .failure(error):
                    self.finishJoin(.failure(error)); self.finishLeave()
                }
            }
        }
    }

    private func applyMacAssociation(ssid: String, passphrase: String, generation gen: Int, deadline: TimeInterval, authorizationFacts: MacHotspotAuthorizationFacts, authorization: MacHotspotAuthorization) {
        let association = MacHotspotAssociation(deadline: deadline, authorizationFacts: authorizationFacts, authorization: authorization)
        macAssociation = association
        applying = true
        macWorker.async {
            let result = Result { try association.associate(ssid: ssid, password: passphrase) }
            self.queue.async {
                guard gen == self.generation else { return }
                self.applying = false
                if self.cancelled { self.finishLeave(); return }
                switch result {
                case let .success(name):
                    let index = Int(if_nametoindex(name))
                    guard index > 0 else {
                        self.finishJoin(.failure(LocalMediaError("Mac Wi-Fi interface disappeared during association")))
                        self.finishLeave(); return
                    }
                    self.wifiIdentity.observe([HotspotInterfaceReport(name: name, index: index, isWifi: true)])
                    self.waitForMacAddress(ssid: ssid, association: association, generation: gen, remaining: 60)
                case let .failure(error):
                    self.finishJoin(.failure(error)); self.finishLeave()
                }
            }
        }
    }

    private func waitForMacAddress(ssid: String, association: MacHotspotAssociation, generation gen: Int, remaining: Int) {
        guard gen == generation, !cancelled else { return }
        macWorker.async {
            let membership = Result { try association.currentSSID() == ssid }
            self.queue.async {
                guard gen == self.generation, !self.cancelled else { return }
                if case let .failure(error) = membership {
                    self.finishJoin(.failure(error)); self.finishLeave(); return
                }
                if (try? membership.get()) == true, let selected = self.selectBinding() {
                    self.bind(selected)
                    self.finishAssociation(address: selected.address, generation: gen)
                } else if remaining > 0 {
                    self.queue.asyncAfter(deadline: .now() + 0.5) {
                        self.waitForMacAddress(ssid: ssid, association: association, generation: gen, remaining: remaining - 1)
                    }
                } else {
                    self.finishJoin(.failure(LocalMediaError("Mac Wi-Fi has no verified glasses hotspot address")))
                    self.finishLeave()
                }
            }
        }
    }

    private func applyConfiguration(ssid: String, passphrase: String, generation gen: Int, remaining: Int = 60) {
        let config = NEHotspotConfiguration(ssid: ssid, passphrase: passphrase, isWEP: false)
        config.joinOnce = false
        applying = true
        ownsConfiguration = true
        applies += 1
        logger.info("HOTSPOT_JOIN apply_start attempt=\(self.applies) ios_on_mac=\(ProcessInfo.processInfo.isiOSAppOnMac)")
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
                self.waitForAddress(ssid: ssid, passphrase: passphrase, generation: gen, remaining: remaining, pollsSinceApply: 0)
            }
        }
    }

    private func waitForAddress(ssid: String, passphrase: String, generation gen: Int, remaining: Int, pollsSinceApply: Int) {
        guard gen == generation, !cancelled else { return }
        NEHotspotNetwork.fetchCurrent { [weak self] network in
            self?.queue.async {
                guard let self, gen == self.generation, !self.cancelled else { return }
                // The selection applies the BLE gateway's client check when one was reported.
                if network?.ssid == ssid, let selected = self.selectBinding() {
                    self.bind(selected)
                    self.finishAssociation(address: selected.address, generation: gen)
                } else if remaining > 0, network?.ssid != ssid,
                          self.reapplyPolicy.shouldReapply(applies: self.applies, pollsSinceApply: pollsSinceApply) {
                    // iOS reports the request applied even when its one scan missed the hotspot.
                    self.logger.info("HOTSPOT_JOIN reapply after_polls=\(pollsSinceApply)")
                    self.applyConfiguration(ssid: ssid, passphrase: passphrase, generation: gen, remaining: remaining)
                } else if remaining > 0 {
                    self.queue.asyncAfter(deadline: .now() + 0.5) {
                        self.waitForAddress(ssid: ssid, passphrase: passphrase, generation: gen, remaining: remaining - 1, pollsSinceApply: pollsSinceApply + 1)
                    }
                } else {
                    let association = network == nil ? "unavailable" : (network?.ssid == ssid ? "matched" : "different")
                    self.finishJoin(.failure(LocalMediaError("Glasses hotspot has no verified Wi-Fi address (SSID=\(association), \(self.wifiDiagnostic()))")))
                    self.finishLeave()
                }
            }
        }
    }

    /// iOS can omit an internet-less Wi-Fi from its default path, and iOS-on-Mac has rejected
    /// a Wi-Fi type constraint on a usable hotspot route. Both paths' interface types feed one
    /// session identity (HotspotWifiIdentity): a positive Wi-Fi report outlives later omission
    /// only while the same interface stays attached; contrary reports and replacement fail closed.
    /// A phone that starts on cellular never gets a report; HotspotInterfacePolicy then uses
    /// the hotspot client address as the evidence.
    private func startInterfaceMonitors(generation gen: Int) {
        interfaceMonitors.forEach { $0.cancel() }
        let monitors = [NWPathMonitor(requiredInterfaceType: .wifi), NWPathMonitor()]
        interfaceMonitors = monitors
        wifiIdentity = HotspotWifiIdentity()
        for monitor in monitors {
            monitor.pathUpdateHandler = { [weak self] path in
                guard let self, gen == self.generation else { return }
                self.wifiIdentity.observe(path.availableInterfaces.map {
                    HotspotInterfaceReport(name: $0.name, index: $0.index, isWifi: $0.type == .wifi)
                })
                // This AP intentionally has no internet. Loss of its default internet path is not
                // loss of the local link; check the verified interface and address instead.
                if let binding = self.binding, !self.cancelled, !self.isBindingIntact(binding) {
                    self.onLost?("Glasses hotspot connection was lost")
                }
            }
            monitor.start(queue: queue)
        }
    }

    /// Every check samples interfaces first, so a detach or replacement between path updates
    /// is recorded in the session identity before it is used.
    private func observeInterfaces() -> HotspotInterfaceSnapshot {
        let snapshot = Self.interfaceSnapshot()
        wifiIdentity.observe(snapshot)
        return snapshot
    }

    private func selectBinding() -> HotspotInterfaceBinding? {
        HotspotInterfacePolicy.select(snapshot: observeInterfaces(), identity: wifiIdentity, gateway: gatewayAddress)
    }

    private func isBindingIntact(_ binding: HotspotInterfaceBinding) -> Bool {
        let snapshot = observeInterfaces()
        return HotspotInterfacePolicy.isIntact(binding, snapshot: snapshot, identity: wifiIdentity)
    }

    private func bind(_ selected: HotspotInterfaceBinding) {
        let evidence = wifiIdentity.trusted[selected.interface] == selected.index ? "wifi_report" : "hotspot_client"
        wifiIdentity.adopt(selected)
        binding = selected
        logger.info("HOTSPOT_JOIN address_verified interface=\(selected.interface, privacy: .public) evidence=\(evidence, privacy: .public)")
    }

    /// Interface names and their IPv4 addresses only; never credentials or SSIDs.
    private func wifiDiagnostic() -> String {
        let snapshot = observeInterfaces()
        let wifi = Set(wifiIdentity.trusted.keys)
        let addresses = snapshot.addresses.filter { wifi.contains($0.name) }.map { "\($0.name)=\($0.ipv4)" }
        let other = snapshot.addresses.filter { !wifi.contains($0.name) && LocalMediaPolicy.isPrivate($0.ipv4) }
            .map { "\($0.name)\(snapshot.ethernetLinks.contains($0.name) ? "" : "(non-ethernet)")=\($0.ipv4)" }
        return "Wi-Fi interfaces=\(wifi.isEmpty ? "none" : wifi.sorted().joined(separator: ",")), " +
            "Wi-Fi IPv4=\(addresses.isEmpty ? "none" : addresses.sorted().joined(separator: ",")), " +
            "other private IPv4=\(other.isEmpty ? "none" : other.sorted().joined(separator: ","))"
    }

    private func finishAssociation(address: String, generation gen: Int) {
        // OTA serves incoming TCP. Its native listener proves server readiness; dialing
        // the glasses' unrelated Gallery server would add a client permission dependency.
        // TN3179: accepting incoming TCP does not require Local Network access.
        if accessPurpose == .incomingServer {
            finishJoin(.success(address))
        } else {
            waitForLocalAccess(address: address, generation: gen)
        }
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
        guard !finishingLeave else { return }
        finishingLeave = true
        macCleanupContinuation?.cleanupStarted()
        if let association = macAssociation {
            association.cancel()
            // This queue is also the association queue: cleanup cannot overtake
            // a blocking scan/join, and process-wide ownership remains held.
            macWorker.async {
                let result = Result { try association.leave() }
                self.queue.async {
                    switch result {
                    case .success:
                        self.macAssociation = nil
                        self.completeLeave()
                    case let .failure(error):
                        // Retain the owner when we cannot prove which association
                        // cleanup would disconnect. A later leave can retry safely.
                        self.finishingLeave = false
                        let completion = self.leaveCompletion
                        self.leaveCompletion = nil
                        completion?.complete(.failure(error))
                        self.macCleanupContinuation?.cleanupFailed()
                    }
                }
            }
        } else { completeLeave() }
    }

    private func completeLeave() {
        internetObservationOwner.cancel()
        macCleanupContinuation = nil
        generation += 1
        macAuthorization?.cancel(); macAuthorization = nil
        localAccess?.cancel(); localAccess = nil
        interfaceMonitors.forEach { $0.cancel() }
        interfaceMonitors = []
        wifiIdentity = HotspotWifiIdentity()
        if let ssid, ownsConfiguration { NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid) }
        ownsConfiguration = false
        ssid = nil
        binding = nil
        gatewayAddress = nil
        let finish = {
            self.waitForInternetAfterLeave = false
            self.finishingLeave = false
            let completion = self.leaveCompletion
            self.leaveCompletion = nil
            if let completion { completion.complete(.success(())) } else {
                if let token = self.ownershipToken { HotspotNetworkOwnership.shared.release(token) }
                self.ownershipToken = nil
            }
        }
        if waitForInternetAfterLeave, ProcessInfo.processInfo.isiOSAppOnMac {
            // Keep this owner until the default route returns or the existing
            // bounded observation ends. Route readiness is not HTTP success;
            // the following ordinary update check still owns that result.
            startInternetObservation(allowWifiAfterRelease: true) { ready, reason in
                self.logger.info("HOTSPOT_LEAVE internet_recovery ready=\(ready) reason=\(reason, privacy: .public)")
                finish()
            }
        } else { finish() }
    }

    /// Every attached interface's kernel index and link type (its AF_LINK row) and every IPv4
    /// address with its interface name and up state. Selection belongs to HotspotInterfacePolicy;
    /// an interface name alone never identifies Wi-Fi. A failed read yields an empty sample, which
    /// fails closed.
    static func interfaceSnapshot() -> HotspotInterfaceSnapshot {
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0 else { return HotspotInterfaceSnapshot(links: [:], addresses: []) }
        defer { freeifaddrs(interfaces) }
        var links: [String: Int] = [:]
        var ethernetLinks: Set<String> = []
        var rows: [HotspotInterfaceAddress] = []
        var cursor = interfaces
        while let item = cursor {
            defer { cursor = item.pointee.ifa_next }
            let value = item.pointee
            guard let address = value.ifa_addr else { continue }
            let name = String(cString: value.ifa_name)
            if address.pointee.sa_family == UInt8(AF_LINK) {
                let (index, type) = address.withMemoryRebound(to: sockaddr_dl.self, capacity: 1) {
                    (Int($0.pointee.sdl_index), Int32($0.pointee.sdl_type))
                }
                if index > 0 {
                    links[name] = index
                    if type == IFT_ETHER { ethernetLinks.insert(name) }
                }
                continue
            }
            guard address.pointee.sa_family == UInt8(AF_INET) else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            rows.append(HotspotInterfaceAddress(name: name, isUp: value.ifa_flags & UInt32(IFF_UP) != 0, ipv4: String(cString: host)))
        }
        return HotspotInterfaceSnapshot(links: links, addresses: rows, ethernetLinks: ethernetLinks)
    }
}
