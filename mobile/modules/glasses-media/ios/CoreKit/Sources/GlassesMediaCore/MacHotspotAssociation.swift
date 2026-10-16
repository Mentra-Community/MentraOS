import CoreLocation
import Foundation
import ObjectiveC

/// Blocking public CoreWLAN calls are isolated here; the existing hotspot owner
/// retains custody until they return, even after cancellation or a timeout.
final class MacHotspotAssociation {
    private let condition = NSCondition()
    private var cancelled = false
    private var interface: MacWifiInterface?
    private var joinedSSID: String?
    private let deadline: TimeInterval
    private let now: () -> TimeInterval
    private let pause: ((TimeInterval) -> Void)?
    private let makeInterface: () throws -> MacWifiInterface

    init(deadline: TimeInterval = ProcessInfo.processInfo.systemUptime + 60,
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         pause: ((TimeInterval) -> Void)? = nil,
         makeInterface: @escaping () throws -> MacWifiInterface = { try PublicCoreWlanInterface() })
    {
        self.deadline = deadline
        self.now = now
        self.pause = pause
        self.makeInterface = makeInterface
    }

    func associate(ssid: String, password: String) throws -> String {
        try checkCurrent()
        let interface = try makeInterface()
        self.interface = interface
        if try interface.currentSSID() != ssid {
            let network = try discoverNetwork(ssid: ssid, interface: interface)
            try checkDiscoveryCurrent()
            if let network, try interface.currentSSID() != ssid {
                try checkDiscoveryCurrent()
                // Record the intended association before this blocking call. A late
                // successful join still belongs to us and must be cleaned up.
                joinedSSID = ssid
                try interface.associate(network: network, password: password)
            }
        }
        try checkCurrent()
        guard try interface.currentSSID() == ssid else {
            throw LocalMediaError("Mac Wi-Fi did not associate with the requested glasses hotspot")
        }
        return try interface.name()
    }

    func cancel() {
        condition.lock(); cancelled = true; condition.broadcast(); condition.unlock()
    }

    /// Run on the same worker as association, after its blocking call returns.
    /// A connection the user replaced must never be disconnected by our cleanup.
    func leave() throws {
        if let joinedSSID {
            if try interface?.currentSSID() == joinedSSID {
                interface?.disassociate()
                guard try interface?.currentSSID() != joinedSSID else {
                    throw LocalMediaError("Mac Wi-Fi has not released the glasses hotspot")
                }
            }
        }
        interface = nil
        joinedSSID = nil
    }

    func currentSSID() throws -> String? {
        try interface?.currentSSID()
    }

    private func discoverNetwork(ssid: String, interface: MacWifiInterface) throws -> NSObject? {
        while true {
            try checkDiscoveryCurrent()
            // Recheck Location authorization before and after each blocking scan.
            if try interface.currentSSID() == ssid { return nil }
            let network = try interface.network(ssid: ssid)
            try checkDiscoveryCurrent()
            if try interface.currentSSID() == ssid { return nil }
            if let network { return network }
            // Successful empty scans remain pending within this same join window.
            // Native scan errors escape immediately; association is never retried.
            let remaining = max(0, deadline - now())
            if let pause { pause(min(1, remaining)) }
            else {
                condition.lock()
                if !cancelled { _ = condition.wait(until: Date(timeIntervalSinceNow: min(1, remaining))) }
                condition.unlock()
            }
        }
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
}

enum MacWifiInvocation {
    // Objective-C NSError** parameters use autoreleasing writeback. Strong
    // pointer storage would over-release errors when the native pool drains.
    typealias Scan = @convention(c) (AnyObject, Selector, NSData, AutoreleasingUnsafeMutablePointer<NSError?>) -> Unmanaged<NSSet>?
    typealias Associate = @convention(c) (AnyObject, Selector, AnyObject, NSString, AutoreleasingUnsafeMutablePointer<NSError?>) -> Bool
}

/// CoreWLAN is a public macOS framework. Foundation loads it only in the Mac
/// process; Apple dyld permits macOS frameworks in iOS-on-Mac. The checked
/// Objective-C signatures below are the public CWInterface SDK declarations.
private final class PublicCoreWlanInterface: MacWifiInterface {
    private let bundle: Bundle
    private let interface: NSObject
    private typealias Disassociate = @convention(c) (AnyObject, Selector) -> Void

    init() throws {
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
        self.bundle = bundle
    }

    func name() throws -> String {
        guard let name = interface.perform(NSSelectorFromString("interfaceName"))?.takeUnretainedValue() as? String,
              !name.isEmpty else { throw LocalMediaError("Mac Wi-Fi interface has no identity") }
        return name
    }

    func currentSSID() throws -> String? {
        let authorization = CLLocationManager.authorizationStatus()
        guard MacHotspotAuthorization.isAuthorized(authorization) else {
            throw LocalMediaError("Location access is required to verify the current Mac Wi-Fi network")
        }
        guard let data = interface.perform(NSSelectorFromString("ssidData"))?.takeUnretainedValue() as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func network(ssid: String) throws -> NSObject? {
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
        let selector = NSSelectorFromString("associateToNetwork:password:error:")
        let invoke = unsafeBitCast(interface.method(for: selector), to: MacWifiInvocation.Associate.self)
        var error: NSError?
        guard invoke(interface, selector, network, password as NSString, &error) else { throw Self.failure("association", error) }
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
