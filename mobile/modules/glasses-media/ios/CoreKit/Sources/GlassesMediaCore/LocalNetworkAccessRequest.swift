import Foundation
import Network

protocol LocalNetworkAccessConnection: AnyObject {
    var onState: ((NWConnection.State, NWPath.UnsatisfiedReason?) -> Void)? { get set }
    func start(queue: DispatchQueue)
    func cancel()
}

/// Wait for permission to use the verified local route before starting timed media work.
/// Connect to the glasses' existing gallery HTTP endpoint to prove local access (TN3179).
/// Network.framework retries when access is granted. A denied path can also mean that the
/// alert is still open, so it must not be treated as a terminal error or given a media timeout.
/// Ordinary connection setup has a 30-second budget, paused while permission is required.
public final class LocalNetworkAccessRequest {
    private let queue: DispatchQueue
    private let connection: LocalNetworkAccessConnection
    private let now: () -> TimeInterval
    private let scheduleTimeout: (TimeInterval, DispatchWorkItem) -> Void
    private var remainingConnectivityTime: TimeInterval = 30
    private var timeoutDeadline: TimeInterval?
    private var timeoutWork: DispatchWorkItem?
    private var completion: ((Result<Void, Error>) -> Void)?
    private var waiting: (() -> Void)?
    private var finished = false
    private var reportedPermission = false

    public convenience init(localAddress: String, gateway: String, queue: DispatchQueue) {
        self.init(connection: LocalNetworkPermissionConnection(localAddress: localAddress, gateway: gateway), queue: queue)
    }

    init(connection: LocalNetworkAccessConnection, queue: DispatchQueue,
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         scheduleTimeout: ((TimeInterval, DispatchWorkItem) -> Void)? = nil)
    {
        self.connection = connection
        self.queue = queue
        self.now = now
        self.scheduleTimeout = scheduleTimeout ?? { delay, work in queue.asyncAfter(deadline: .now() + delay, execute: work) }
    }

    public func start(onPermissionRequired: @escaping () -> Void, completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async {
            guard !self.finished, self.completion == nil else { return }
            self.completion = completion
            self.waiting = onPermissionRequired
            self.connection.onState = { [weak self] state, reason in
                guard let self, !self.finished else { return }
                switch state {
                case .ready: self.finish(.success(()))
                case .waiting where reason == .localNetworkDenied:
                    self.pauseConnectivityTimeout()
                    if !self.reportedPermission {
                        self.reportedPermission = true
                        self.waiting?()
                    }
                // Waiting errors are nonfatal; NWConnection retries when its path recovers.
                // A nil path is not proof of denied permission, but must not fail immediately.
                case .setup, .preparing, .waiting: self.resumeConnectivityTimeout()
                case let .failed(error): self.finish(.failure(error))
                case .cancelled: self.finish(.failure(CancellationError()))
                @unknown default: break
                }
            }
            self.resumeConnectivityTimeout()
            self.connection.start(queue: self.queue)
        }
    }

    public func cancel() {
        queue.async { self.finish(.failure(CancellationError())) }
    }

    private func resumeConnectivityTimeout() {
        guard timeoutDeadline == nil else { return }
        let deadline = now() + remainingConnectivityTime
        timeoutDeadline = deadline
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.timeoutDeadline == deadline else { return }
            self.finish(.failure(LocalMediaError("Local connection to the glasses timed out")))
        }
        timeoutWork = work
        scheduleTimeout(remainingConnectivityTime, work)
    }

    private func pauseConnectivityTimeout() {
        if let deadline = timeoutDeadline { remainingConnectivityTime = max(0, deadline - now()) }
        timeoutDeadline = nil
        timeoutWork?.cancel()
        timeoutWork = nil
    }

    private func finish(_ result: Result<Void, Error>) {
        guard !finished else { return }
        finished = true
        pauseConnectivityTimeout()
        connection.onState = nil
        connection.cancel()
        let reply = completion
        completion = nil
        waiting = nil
        reply?(result)
    }
}

private final class LocalNetworkPermissionConnection: LocalNetworkAccessConnection {
    var onState: ((NWConnection.State, NWPath.UnsatisfiedReason?) -> Void)?
    private let connection: NWConnection

    init(localAddress: String, gateway: String) {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(localAddress), port: .any)
        connection = NWConnection(host: NWEndpoint.Host(gateway), port: 8089, using: parameters)
    }

    func start(queue: DispatchQueue) {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            onState?(state, connection.currentPath?.unsatisfiedReason)
        }
        // The path reason can arrive after a waiting update with no currentPath yet.
        connection.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            onState?(connection.state, path.unsatisfiedReason)
        }
        connection.start(queue: queue)
    }

    func cancel() {
        connection.stateUpdateHandler = nil
        connection.pathUpdateHandler = nil
        connection.cancel()
    }
}
