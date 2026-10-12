import CoreLocation
import Foundation
import ObjectiveC

/// Blocking public CoreWLAN calls are isolated here; the existing hotspot owner
/// retains custody until they return, even after cancellation or a timeout.
final class MacHotspotAssociation {
    private let lock = NSLock()
    private var cancelled = false
    private var interface: MacWifiInterface?
    private var joinedSSID: String?
    private let makeInterface: () throws -> MacWifiInterface

    init(makeInterface: @escaping () throws -> MacWifiInterface = { try PublicCoreWlanInterface() }) {
        self.makeInterface = makeInterface
    }

    func associate(ssid: String, password: String) throws -> String {
        try checkCurrent()
        let interface = try makeInterface()
        self.interface = interface
        if try interface.currentSSID() != ssid {
            let network = try interface.network(ssid: ssid)
            try checkCurrent()
            // Record the intended association before this blocking call. A late
            // successful join still belongs to us and must be cleaned up.
            joinedSSID = ssid
            try interface.associate(network: network, password: password)
        }
        try checkCurrent()
        guard try interface.currentSSID() == ssid else {
            throw LocalMediaError("Mac Wi-Fi did not associate with the requested glasses hotspot")
        }
        return try interface.name()
    }

    func cancel() {
        lock.lock(); cancelled = true; lock.unlock()
    }

    /// Run on the same worker as association, after its blocking call returns.
    /// A connection the user replaced must never be disconnected by our cleanup.
    func leave() throws {
        if let joinedSSID {
            if try interface?.currentSSID() == joinedSSID { interface?.disassociate() }
        }
        interface = nil
        joinedSSID = nil
    }

    func currentSSID() throws -> String? {
        try interface?.currentSSID()
    }

    private func checkCurrent() throws {
        lock.lock(); let stopped = cancelled; lock.unlock()
        if stopped { throw CancellationError() }
    }
}

protocol MacWifiInterface: AnyObject {
    func name() throws -> String
    func currentSSID() throws -> String?
    func network(ssid: String) throws -> NSObject
    func associate(network: NSObject, password: String) throws
    func disassociate()
}

/// CoreWLAN is a public macOS framework. Foundation loads it only in the Mac
/// process; Apple dyld permits macOS frameworks in iOS-on-Mac. The checked
/// Objective-C signatures below are the public CWInterface SDK declarations.
private final class PublicCoreWlanInterface: MacWifiInterface {
    private let bundle: Bundle
    private let interface: NSObject
    private typealias Scan = @convention(c) (AnyObject, Selector, NSData, UnsafeMutablePointer<NSError?>) -> Unmanaged<NSSet>?
    private typealias Associate = @convention(c) (AnyObject, Selector, AnyObject, NSString, UnsafeMutablePointer<NSError?>) -> Bool
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

    func network(ssid: String) throws -> NSObject {
        let selector = NSSelectorFromString("scanForNetworksWithSSID:error:")
        let invoke = unsafeBitCast(interface.method(for: selector), to: Scan.self)
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
        throw LocalMediaError("The requested glasses hotspot was not found by Mac Wi-Fi")
    }

    func associate(network: NSObject, password: String) throws {
        let selector = NSSelectorFromString("associateToNetwork:password:error:")
        let invoke = unsafeBitCast(interface.method(for: selector), to: Associate.self)
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
