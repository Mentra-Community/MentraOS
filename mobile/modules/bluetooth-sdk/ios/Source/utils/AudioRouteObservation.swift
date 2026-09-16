import Combine
import Foundation

/// Keeps audio readiness observable before microphone capture has been started.
final class AudioRouteObservation {
    private var subscriptions = Set<AnyCancellable>()

    init(
        center: NotificationCenter = .default,
        names: [Notification.Name],
        onChange: @escaping () -> Void
    ) {
        for name in names {
            center.publisher(for: name)
                .receive(on: DispatchQueue.main)
                .sink { _ in onChange() }
                .store(in: &subscriptions)
        }
    }
}
