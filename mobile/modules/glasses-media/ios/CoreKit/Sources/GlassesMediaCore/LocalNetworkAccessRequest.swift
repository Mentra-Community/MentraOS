import Foundation
import Network

enum LocalNetworkAccessState {
    case ready
    case permissionRequired
    case failed(Error)
}

protocol LocalNetworkAccessConnection: AnyObject {
    var onState: ((LocalNetworkAccessState) -> Void)? { get set }
    func start(queue: DispatchQueue)
    func cancel()
}

/// Wait for permission to use the verified local route before starting timed media work.
/// Connect to the glasses' existing gallery HTTP endpoint to prove local access (TN3179).
/// Network.framework retries when access is granted. A denied path can also mean that the
/// alert is still open, so it must not be treated as a terminal error or given a media timeout.
public final class LocalNetworkAccessRequest {
    private let queue: DispatchQueue
    private let connection: LocalNetworkAccessConnection
    private var completion: ((Result<Void, Error>) -> Void)?
    private var waiting: (() -> Void)?
    private var finished = false
    private var reportedPermission = false

    public convenience init(localAddress: String, gateway: String, queue: DispatchQueue) {
        self.init(connection: LocalNetworkPermissionConnection(localAddress: localAddress, gateway: gateway), queue: queue)
    }

    init(connection: LocalNetworkAccessConnection, queue: DispatchQueue) {
        self.connection = connection
        self.queue = queue
    }

    public func start(onPermissionRequired: @escaping () -> Void, completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            guard !self.finished, self.completion == nil else { return }
            self.completion = completion
            self.waiting = onPermissionRequired
            self.connection.onState = { [weak self] state in
                guard let self, !self.finished else { return }
                switch state {
                case .ready: self.finish(.success(()))
                case .permissionRequired:
                    if !self.reportedPermission {
                        self.reportedPermission = true
                        self.waiting?()
                    }
                case let .failed(error): self.finish(.failure(error))
                }
            }
            self.connection.start(queue: self.queue)
        }
    }

    public func cancel() {
        queue.async { self.finish(.failure(CancellationError())) }
    }

    private func finish(_ result: Result<Void, Error>) {
        guard !finished else { return }
        finished = true
        connection.onState = nil
        connection.cancel()
        let reply = completion
        completion = nil
        waiting = nil
        reply?(result)
    }
}

private final class LocalNetworkPermissionConnection: LocalNetworkAccessConnection {
    var onState: ((LocalNetworkAccessState) -> Void)?
    private let connection: NWConnection

    init(localAddress: String, gateway: String) {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(localAddress), port: .any)
        connection = NWConnection(host: NWEndpoint.Host(gateway), port: 8089, using: parameters)
    }

    func start(queue: DispatchQueue) {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready: onState?(.ready)
            case let .waiting(error):
                if connection.currentPath?.unsatisfiedReason == .localNetworkDenied {
                    onState?(.permissionRequired)
                } else {
                    onState?(.failed(error))
                }
            case let .failed(error): onState?(.failed(error))
            default: break
            }
        }
        connection.start(queue: queue)
    }

    func cancel() {
        connection.stateUpdateHandler = nil
        connection.cancel()
    }
}
