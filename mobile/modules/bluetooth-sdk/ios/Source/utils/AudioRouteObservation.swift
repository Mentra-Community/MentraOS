import Combine
import Foundation

/// Keeps audio readiness observable before microphone capture has been started.
final class AudioRouteObservation {
    private var subscriptions = Set<AnyCancellable>()
    private var pendingRecheck: DispatchWorkItem?
    private var generation = 0
    private let settlingDelays: [TimeInterval]
    private let onChange: () -> Void

    init(
        center: NotificationCenter = .default,
        names: [Notification.Name],
        settlingDelays: [TimeInterval] = [0.2, 0.3, 0.5],
        onChange: @escaping () -> Void
    ) {
        self.settlingDelays = settlingDelays
        self.onChange = onChange
        for name in names {
            center.publisher(for: name)
                .receive(on: DispatchQueue.main)
                .sink { [weak self] _ in self?.refresh() }
                .store(in: &subscriptions)
        }
    }

    deinit {
        pendingRecheck?.cancel()
    }

    /// Start a new settling window for a route, foreground, or selected-device
    /// change. The callback must read the current target and route each time.
    func refresh() {
        dispatchPrecondition(condition: .onQueue(.main))
        pendingRecheck?.cancel()
        generation += 1
        reconcile(generation: generation, nextDelay: 0)
    }

    private func reconcile(generation: Int, nextDelay: Int) {
        guard generation == self.generation else { return }
        onChange()
        // availableInputs can lag the notification, including after removal.
        // Reconcile at 200, 500, and 1000 ms even if the first read was ready.
        // A reentrant refresh also supersedes this window.
        guard generation == self.generation, nextDelay < settlingDelays.count else { return }
        let recheck = DispatchWorkItem { [weak self] in
            self?.reconcile(generation: generation, nextDelay: nextDelay + 1)
        }
        pendingRecheck = recheck
        DispatchQueue.main.asyncAfter(deadline: .now() + settlingDelays[nextDelay], execute: recheck)
    }
}
