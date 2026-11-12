import CoreLocation
import Foundation
import ObjectiveC

/// Blocking public CoreWLAN calls are isolated here; the existing hotspot owner
/// retains custody until they return, even after cancellation or a timeout.
final class MacHotspotAssociation {
    /// Rejoining the hotspot seconds after leaving it, as between an update's passes, can be refused while the
    /// glasses still hold the Mac's previous association (-3912). A later attempt in the same window succeeds.
    static let associationAttempts = 3
    static let associationRetryDelay: TimeInterval = 2
    /// After leaving, macOS auto-join normally returns to the previous network within a few seconds.
    static let autoJoinWait: TimeInterval = 15
    /// Auto-join after a Wi-Fi power cycle: 2 s on lab air-1.
    static let powerCycleWait: TimeInterval = 30

    private let condition = NSCondition()
    private var cancelled = false
    private var interface: MacWifiInterface?
    private var joinedSSID: String?
    /// The Wi-Fi network the Mac was on before this join, which every leave returns it to.
    private var previousSSID: String?
    private let deadline: TimeInterval
    private let now: () -> TimeInterval
    private let pause: ((TimeInterval) -> Void)?
    private let makeInterface: () throws -> MacWifiInterface
    private let authorization: MacHotspotAuthorization?

    init(deadline: TimeInterval = ProcessInfo.processInfo.systemUptime + 60,
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         pause: ((TimeInterval) -> Void)? = nil,
         makeInterface: (() throws -> MacWifiInterface)? = nil,
         authorizationFacts: MacHotspotAuthorizationFacts? = nil,
         authorization: MacHotspotAuthorization? = nil)
    {
        self.deadline = deadline
        self.now = now
        self.pause = pause
        self.authorization = authorization
        self.makeInterface = makeInterface ?? { try PublicCoreWlanInterface(authorizationFacts: authorizationFacts, authorization: authorization) }
    }

    func associate(ssid: String, password: String) throws -> String {
        try checkCurrent()
        let interface = try makeInterface()
        self.interface = interface
        let before = try readSSID(interface)
        if before != ssid { previousSSID = before }
        for attempt in 1 ... Self.associationAttempts {
            guard try readSSID(interface) != ssid else { break }
            let network = try discoverNetwork(ssid: ssid, interface: interface)
            try checkDiscoveryCurrent()
            guard let network, try readSSID(interface) != ssid else { break }
            try checkDiscoveryCurrent()
            try authorization?.requireCurrentAuthorization()
            // Record the intended association before this blocking call. A late
            // successful join still belongs to us and must be cleaned up.
            joinedSSID = ssid
            do {
                try interface.associate(network: network, password: password)
                break
            } catch {
                // A refusal is retried with a fresh scan; cancellation, a lost Location
                // authorization (rechecked by the next read) and the deadline end it.
                if error is CancellationError || attempt == Self.associationAttempts { throw error }
                try checkCurrent()
                guard now() + Self.associationRetryDelay < deadline else { throw error }
                wait(Self.associationRetryDelay)
            }
        }
        try checkCurrent()
        guard try readSSID(interface) == ssid else {
            throw LocalMediaError("Mac Wi-Fi did not associate with the requested glasses hotspot")
        }
        return try interface.name()
    }

    func cancel() {
        condition.lock(); cancelled = true; condition.broadcast(); condition.unlock()
    }

    /// Run on the same worker as association, after its blocking call returns.
    /// A connection the user replaced must never be disconnected by our cleanup.
    ///
    /// Once an association was requested, whether it succeeded, failed or timed out, the
    /// Mac may have left its own network for it and macOS has saved the hotspot as a known
    /// network. Leaving forgets the hotspot and gets the Mac back on the network it was on
    /// before (lab air-1, 2026-11-11: a failed join left it with no network for 5 hours).
    @discardableResult
    func leave() throws -> MacHotspotLeaveReport {
        var report = MacHotspotLeaveReport()
        if let joinedSSID, let interface {
            if try readSSID(interface) == joinedSSID {
                interface.disassociate()
                guard try readSSID(interface) != joinedSSID else {
                    throw LocalMediaError("Mac Wi-Fi has not released the glasses hotspot")
                }
                report.disassociated = true
            }
            do { try interface.forget(ssid: joinedSSID); report.forgotHotspot = true }
            catch { report.failures.append("forget: \(error.localizedDescription)") }
            report.restore = restorePrevious(interface, report: &report)
        }
        interface = nil
        joinedSSID = nil
        previousSSID = nil
        return report
    }

    /// Never takes the Mac off a network it is on: only an interface left with no network is
    /// power cycled. After a failed association air-1's Wi-Fi answered every auto-join scan with
    /// EBUSY for hours; a power cycle starts auto-join over. An app cannot rejoin the previous
    /// network itself: without the passphrase, CoreWLAN answers -3900 (tmpErr).
    private func restorePrevious(_ interface: MacWifiInterface, report: inout MacHotspotLeaveReport) -> MacHotspotRestore {
        guard let previous = previousSSID else { return .noPreviousNetwork }
        if let outcome = settle(interface, previous: previous, within: Self.autoJoinWait, success: .autoJoined) { return outcome }
        do {
            try interface.setPower(false)
            sleep(1)
            try interface.setPower(true)
        } catch {
            report.failures.append("power cycle: \(error.localizedDescription)")
            return .notRestored
        }
        return settle(interface, previous: previous, within: Self.powerCycleWait, success: .powerCycled) ?? .notRestored
    }

    /// Polls once a second until the Mac is on the previous network (success) or on
    /// another one (left alone); nil while it is still on none when the time runs out.
    private func settle(_ interface: MacWifiInterface, previous: String, within seconds: TimeInterval,
                        success: MacHotspotRestore) -> MacHotspotRestore?
    {
        var waited: TimeInterval = 0
        while true {
            // An unreadable SSID (Location revoked) counts as no network: recovery never disconnects.
            switch try? readSSID(interface) {
            case previous?: return success
            case .some: return .otherNetwork
            case nil: break
            }
            guard waited < seconds else { return nil }
            sleep(1); waited += 1
        }
    }

    /// Cleanup pacing: unlike wait(_:), runs after cancel() and must not be cut short by it.
    private func sleep(_ seconds: TimeInterval) {
        if let pause { pause(seconds) } else { Thread.sleep(forTimeInterval: seconds) }
    }

    func currentSSID() throws -> String? {
        guard let interface else { return nil }
        return try readSSID(interface)
    }

    private func readSSID(_ interface: MacWifiInterface) throws -> String? {
        try authorization?.requireCurrentAuthorization()
        let ssid = try interface.currentSSID()
        try authorization?.requireCurrentAuthorization()
        return ssid
    }

    static func observeCurrentSSID() throws -> String? {
        try PublicCoreWlanInterface().currentSSID()
    }

    private func discoverNetwork(ssid: String, interface: MacWifiInterface) throws -> NSObject? {
        while true {
            try checkDiscoveryCurrent()
            // Recheck Location authorization before and after each blocking scan.
            if try readSSID(interface) == ssid { return nil }
            try authorization?.requireCurrentAuthorization()
            let network = try interface.network(ssid: ssid)
            try checkDiscoveryCurrent()
            if try readSSID(interface) == ssid { return nil }
            if let network { return network }
            // Successful empty scans remain pending within this same join window.
            // Native scan errors escape immediately.
            wait(min(1, max(0, deadline - now())))
        }
    }

    /// Pause on the association worker; cancellation wakes it.
    private func wait(_ seconds: TimeInterval) {
        if let pause { pause(seconds); return }
        condition.lock()
        if !cancelled { _ = condition.wait(until: Date(timeIntervalSinceNow: seconds)) }
        condition.unlock()
    }

    private func checkDiscoveryCurrent() throws {
        try checkCurrent()
        guard now() < deadline else {
            throw LocalMediaError("The requested glasses hotspot was not found by Mac Wi-Fi before the hotspot join timed out")
        }
    }

    private func checkCurrent() throws {
        condition.lock(); let stopped = cancelled; condition.unlock()
        if stopped { throw CancellationError() }
    }
}

protocol MacWifiInterface: AnyObject {
    func name() throws -> String
    func currentSSID() throws -> String?
    func network(ssid: String) throws -> NSObject?
    func associate(network: NSObject, password: String) throws
    func disassociate()
    /// Removes the network from the Mac's known networks, so auto-join never picks it.
    func forget(ssid: String) throws
    func setPower(_ on: Bool) throws
}

/// What leaving did to the Mac's Wi-Fi, for the hotspot log. Never holds an SSID.
struct MacHotspotLeaveReport: Equatable {
    var disassociated = false
    var forgotHotspot = false
    var restore: MacHotspotRestore = .notNeeded
    var failures: [String] = []

    var summary: String {
        "disassociated=\(disassociated) forgot_hotspot=\(forgotHotspot) previous_network=\(restore.rawValue)" +
            (failures.isEmpty ? "" : " failures=[\(failures.joined(separator: "; "))]")
    }
}

enum MacHotspotRestore: String, Equatable {
    /// No association was requested, so the Mac never left its network.
    case notNeeded = "not_needed"
    case noPreviousNetwork = "none_before"
    case autoJoined = "auto_joined"
    case powerCycled = "power_cycled"
    /// The Mac is on a network other than the previous one, which recovery leaves alone.
    case otherNetwork = "other_network"
    case notRestored = "not_restored"
}

enum MacWifiInvocation {
    // Objective-C NSError** parameters use autoreleasing writeback. Strong
    // pointer storage would over-release errors when the native pool drains.
    typealias Scan = @convention(c) (AnyObject, Selector, NSData, AutoreleasingUnsafeMutablePointer<NSError?>) -> Unmanaged<NSSet>?
    typealias Associate = @convention(c) (AnyObject, Selector, AnyObject, NSString, AutoreleasingUnsafeMutablePointer<NSError?>) -> Bool
    typealias Forget = @convention(c) (AnyObject, Selector, NSData, UInt64, AutoreleasingUnsafeMutablePointer<NSError?>) -> Bool
    typealias SetPower = @convention(c) (AnyObject, Selector, Bool, AutoreleasingUnsafeMutablePointer<NSError?>) -> Bool
}

/// CoreWLAN is a public macOS framework. Foundation loads it only in the Mac
/// process; Apple dyld permits macOS frameworks in iOS-on-Mac. The checked
/// Objective-C signatures below are the public CWInterface SDK declarations.
private final class PublicCoreWlanInterface: MacWifiInterface {
    private let bundle: Bundle
    private let interface: NSObject
    private let client: NSObject
    private let authorizationFacts: MacHotspotAuthorizationFacts
    private let authorization: MacHotspotAuthorization?
    private typealias Disassociate = @convention(c) (AnyObject, Selector) -> Void

    init(authorizationFacts: MacHotspotAuthorizationFacts? = nil, authorization: MacHotspotAuthorization? = nil) throws {
        self.authorizationFacts = authorizationFacts ?? MacHotspotAuthorizationFacts()
        self.authorization = authorization
        guard let bundle = Bundle(path: "/System/Library/Frameworks/CoreWLAN.framework") else {
            throw LocalMediaError("Mac Wi-Fi framework is unavailable")
        }
        do { try bundle.loadAndReturnError() }
        catch { throw Self.failure("framework loading", error as NSError) }
        guard let clientClass = NSClassFromString("CWWiFiClient") as? NSObject.Type,
              clientClass.responds(to: NSSelectorFromString("sharedWiFiClient")),
              let client = clientClass.perform(NSSelectorFromString("sharedWiFiClient"))?.takeUnretainedValue() as? NSObject,
              client.responds(to: NSSelectorFromString("interface")),
              let interface = client.perform(NSSelectorFromString("interface"))?.takeUnretainedValue() as? NSObject
        else { throw LocalMediaError("Mac Wi-Fi interface is unavailable") }
        for method in ["interfaceName", "ssidData", "scanForNetworksWithSSID:error:", "associateToNetwork:password:error:", "disassociate"] {
            guard interface.responds(to: NSSelectorFromString(method)) else {
                throw LocalMediaError("Mac Wi-Fi interface does not support hotspot association")
            }
        }
        self.interface = interface
        self.client = client
        self.bundle = bundle
    }

    func name() throws -> String {
        guard let name = interface.perform(NSSelectorFromString("interfaceName"))?.takeUnretainedValue() as? String,
              !name.isEmpty else { throw LocalMediaError("Mac Wi-Fi interface has no identity") }
        return name
    }

    func currentSSID() throws -> String? {
        try requireAuthorization()
        guard let data = interface.perform(NSSelectorFromString("ssidData"))?.takeUnretainedValue() as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func requireAuthorization() throws {
        if let authorization { try authorization.requireCurrentAuthorization(); return }
        // Independent internet-return observation has no owned join recipient.
        // Its existing static authorization guard remains unchanged.
        let authorization = CLLocationManager.authorizationStatus()
        guard MacHotspotAuthorization.isAuthorized(authorization) else {
            throw authorizationFacts.failure("Location access is required to verify the current Mac Wi-Fi network", raw: authorization.rawValue,
                                             getter: .staticSSID, foreground: MacHotspotAuthorizationFacts.foreground())
        }
    }

    func network(ssid: String) throws -> NSObject? {
        try requireAuthorization()
        let selector = NSSelectorFromString("scanForNetworksWithSSID:error:")
        let invoke = unsafeBitCast(interface.method(for: selector), to: MacWifiInvocation.Scan.self)
        var error: NSError?
        guard let networks = invoke(interface, selector, NSData(data: Data(ssid.utf8)), &error)?.takeUnretainedValue() else {
            throw Self.failure("scan", error)
        }
        // A directed scan can include unrelated networks. Match the requested
        // SSID bytes without reading or logging BSSID or other scan identities.
        for case let network as NSObject in networks {
            guard network.responds(to: NSSelectorFromString("ssidData")),
                  let data = network.perform(NSSelectorFromString("ssidData"))?.takeUnretainedValue() as? Data,
                  data == Data(ssid.utf8) else { continue }
            return network
        }
        return nil
    }

    func associate(network: NSObject, password: String) throws {
        try requireAuthorization()
        let selector = NSSelectorFromString("associateToNetwork:password:error:")
        let invoke = unsafeBitCast(interface.method(for: selector), to: MacWifiInvocation.Associate.self)
        var error: NSError?
        guard invoke(interface, selector, network, password as NSString, &error) else { throw Self.failure("association", error) }
    }

    /// associateToNetwork saves the network as a known network, and CoreWLAN has no public way to
    /// remove one without an administrator's authorization. CWWiFiClient's forget call needs none.
    func forget(ssid: String) throws {
        let selector = NSSelectorFromString("forgetWiFiProfileWithSSID:event:error:")
        guard client.responds(to: selector) else { throw LocalMediaError("Mac Wi-Fi cannot forget networks") }
        let invoke = unsafeBitCast(client.method(for: selector), to: MacWifiInvocation.Forget.self)
        var error: NSError?
        guard invoke(client, selector, NSData(data: Data(ssid.utf8)), 0, &error) else { throw Self.failure("forget", error) }
    }

    func setPower(_ on: Bool) throws {
        let selector = NSSelectorFromString("setPower:error:")
        guard interface.responds(to: selector) else { throw LocalMediaError("Mac Wi-Fi cannot change power") }
        let invoke = unsafeBitCast(interface.method(for: selector), to: MacWifiInvocation.SetPower.self)
        var error: NSError?
        guard invoke(interface, selector, on, &error) else { throw Self.failure("power", error) }
    }

    func disassociate() {
        let selector = NSSelectorFromString("disassociate")
        let invoke = unsafeBitCast(interface.method(for: selector), to: Disassociate.self)
        invoke(interface, selector)
    }

    private static func failure(_ operation: String, _ error: NSError?) -> Error {
        let domain = error?.domain ?? "unavailable"
        let safeDomain = domain.range(of: "^[A-Za-z0-9_.-]{1,128}$", options: .regularExpression) == nil ? "unavailable" : domain
        return LocalMediaError("Mac Wi-Fi \(operation) failed (\(safeDomain), \(error?.code ?? -1))")
    }
}
