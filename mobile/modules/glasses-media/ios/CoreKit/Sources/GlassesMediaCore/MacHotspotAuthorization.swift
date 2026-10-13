import CoreLocation
import Foundation

/// CoreWLAN requires Location authorization to identify the requested network.
/// Use the app's existing system permission, with no separate connection screen.
final class MacHotspotAuthorization: NSObject, CLLocationManagerDelegate {
    private var manager: CLLocationManager?
    private var completion: ((Result<Void, Error>) -> Void)?
    private var finished = false
    private let diagnostics: MacHotspotJoinDiagnostics?

    init(diagnostics: MacHotspotJoinDiagnostics? = nil) {
        self.diagnostics = diagnostics
        super.init()
    }

    func start(completion: @escaping (Result<Void, Error>) -> Void) {
        DispatchQueue.main.async {
            guard !self.finished else { completion(.failure(CancellationError())); return }
            self.completion = completion
            let manager = CLLocationManager()
            self.manager = manager
            manager.delegate = self
            self.handle(manager.authorizationStatus, initial: true)
            if manager.authorizationStatus == .notDetermined {
                self.diagnostics?.authorizationStatus(Int(manager.authorizationStatus.rawValue), requested: true)
                manager.requestWhenInUseAuthorization()
            }
        }
    }

    func cancel() {
        DispatchQueue.main.async { self.finish(.failure(CancellationError())) }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        handle(manager.authorizationStatus)
    }

    static func isAuthorized(_ status: CLAuthorizationStatus) -> Bool {
        if status == .authorizedAlways { return true }
        #if !os(macOS)
            if status == .authorizedWhenInUse { return true }
        #endif
        return false
    }

    private func handle(_ status: CLAuthorizationStatus, initial: Bool = false) {
        diagnostics?.authorizationStatus(Int(status.rawValue), initial: initial)
        if Self.isAuthorized(status) { finish(.success(())); return }
        switch status {
        case .denied, .restricted:
            finish(.failure(LocalMediaError("Location access is required to identify the glasses hotspot on Mac")))
        case .notDetermined: break
        default:
            finish(.failure(LocalMediaError("Mac hotspot Location authorization is unavailable")))
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
