import CoreLocation
import Foundation

/// CoreWLAN requires Location authorization to identify the requested network.
/// Use the app's existing system permission, with no separate connection screen.
final class MacHotspotAuthorization: NSObject, CLLocationManagerDelegate {
    private var manager: CLLocationManager?
    private var completion: ((Result<Void, Error>) -> Void)?
    private var finished = false
    private let facts: MacHotspotAuthorizationFacts

    init(facts: MacHotspotAuthorizationFacts = MacHotspotAuthorizationFacts()) {
        self.facts = facts
        super.init()
    }

    func start(completion: @escaping (Result<Void, Error>) -> Void) {
        DispatchQueue.main.async {
            guard !self.finished else { completion(.failure(CancellationError())); return }
            self.completion = completion
            let manager = CLLocationManager()
            self.manager = manager
            manager.delegate = self
            self.handle(manager.authorizationStatus, getter: .instanceInitial)
            if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        }
    }

    func cancel() {
        DispatchQueue.main.async { self.finish(.failure(CancellationError())) }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
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
        if !finished { facts.observeInstance(raw: status.rawValue, getter: getter, foreground: foreground) }
        if Self.isAuthorized(status) { finish(.success(())); return }
        switch status {
        case .denied, .restricted:
            finish(.failure(facts.failure("Location access is required to identify the glasses hotspot on Mac", raw: status.rawValue, getter: getter, foreground: foreground)))
        case .notDetermined: break
        default:
            finish(.failure(facts.failure("Mac hotspot Location authorization is unavailable", raw: status.rawValue, getter: getter, foreground: foreground)))
        }
    }

    private func finish(_ result: Result<Void, Error>) {
        guard !finished else { return }
        finished = true
        manager?.delegate = nil
        manager = nil
        let reply = completion
        completion = nil
        reply?(result)
    }
}
