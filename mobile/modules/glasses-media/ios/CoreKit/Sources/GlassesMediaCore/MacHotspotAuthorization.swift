import CoreLocation
import Foundation

/// CoreWLAN requires Location authorization to identify the requested network.
/// Use the app's existing system permission, with no separate connection screen.
final class MacHotspotAuthorization: NSObject, CLLocationManagerDelegate {
    private var manager: CLLocationManager?
    private var completion: ((Result<Void, Error>) -> Void)?
    private var started = false
    private var closed = false
    private var ready = false
    private var revoked = false
    private let facts: MacHotspotAuthorizationFacts
    private let makeManager: () -> CLLocationManager
    private let locationServicesEnabled: () -> Bool
    var onRevoked: ((Error) -> Void)?
    var onRestored: (() -> Void)?

    init(facts: MacHotspotAuthorizationFacts = MacHotspotAuthorizationFacts(), makeManager: @escaping () -> CLLocationManager = { CLLocationManager() },
         locationServicesEnabled: @escaping () -> Bool = { CLLocationManager.locationServicesEnabled() })
    {
        self.facts = facts
        self.makeManager = makeManager
        self.locationServicesEnabled = locationServicesEnabled
        super.init()
    }

    func start(completion: @escaping (Result<Void, Error>) -> Void) {
        DispatchQueue.main.async {
            guard !self.closed, !self.started else { completion(.failure(CancellationError())); return }
            self.started = true
            self.completion = completion
            let manager = self.makeManager()
            self.manager = manager
            manager.delegate = self
            self.handle(manager.authorizationStatus, getter: .instanceInitial)
            if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        }
    }

    func cancel() {
        DispatchQueue.main.async {
            self.closed = true
            self.ready = false
            self.reply(.failure(CancellationError()))
            self.manager?.delegate = nil
            self.manager = nil
            self.onRevoked = nil
            self.onRestored = nil
        }
    }

    /// A ready session retains its manager through owned Wi-Fi cleanup. An unanswered
    /// authorization request must still settle when the join is cancelled.
    func cancelPending() {
        DispatchQueue.main.async {
            if self.completion != nil { self.cancel() }
        }
    }

    /// Query the same initialized recipient on its owning thread for every native read
    /// or write. An earlier success is never an authorization cache.
    func requireCurrentAuthorization() throws {
        let check = {
            guard !self.closed, let manager = self.manager else { throw CancellationError() }
            let status = manager.authorizationStatus
            let foreground = MacHotspotAuthorizationFacts.foreground()
            self.facts.observeInstance(raw: status.rawValue, getter: .instanceCurrent, foreground: foreground)
            guard self.locationServicesEnabled() else {
                throw self.facts.failure("Location services are required to verify the current Mac Wi-Fi network", raw: status.rawValue,
                                         getter: .instanceCurrent, foreground: foreground)
            }
            guard Self.isAuthorized(status) else {
                throw self.facts.failure("Location access is required to verify the current Mac Wi-Fi network", raw: status.rawValue,
                                         getter: .instanceCurrent, foreground: foreground)
            }
        }
        if Thread.isMainThread { try check() }
        else { try DispatchQueue.main.sync(execute: check) }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard manager === self.manager, !closed else { return }
        handle(manager.authorizationStatus, getter: .instanceCallback)
    }

    static func isAuthorized(_ status: CLAuthorizationStatus) -> Bool {
        if status == .authorizedAlways { return true }
        #if !os(macOS)
            if status == .authorizedWhenInUse { return true }
        #endif
        return false
    }

    private func handle(_ status: CLAuthorizationStatus, getter: MacHotspotAuthorizationFacts.Getter) {
        let foreground = MacHotspotAuthorizationFacts.foreground()
        guard !closed else { return }
        facts.observeInstance(raw: status.rawValue, getter: getter, foreground: foreground)
        if Self.isAuthorized(status) {
            ready = true
            if revoked { revoked = false; onRestored?() }
            reply(.success(()))
            return
        }
        let error = facts.failure("Location access is required to identify the glasses hotspot on Mac", raw: status.rawValue, getter: getter, foreground: foreground)
        if ready {
            ready = false
            revoked = true
            onRevoked?(error)
            return
        }
        switch status {
        case .denied, .restricted:
            reply(.failure(error))
        case .notDetermined: break
        default:
            reply(.failure(facts.failure("Mac hotspot Location authorization is unavailable", raw: status.rawValue, getter: getter, foreground: foreground)))
        }
    }

    private func reply(_ result: Result<Void, Error>) {
        let reply = completion
        completion = nil
        reply?(result)
    }
}
