import Foundation

/// Tracks expected audio separately from observed audio. All times use a monotonic clock.
struct GlassesMicWatchdog {
    private var expectedSince: TimeInterval?
    private var lastActivity: TimeInterval?
    private var lastRetry: TimeInterval?
    private let timeout: TimeInterval = 5

    mutating func expectAudio(_ expected: Bool, at now: TimeInterval) {
        guard expected else {
            self = GlassesMicWatchdog()
            return
        }
        if expectedSince == nil {
            expectedSince = now
        }
    }

    mutating func receivedAudio(at now: TimeInterval) {
        guard expectedSince != nil else { return }
        lastActivity = now
    }

    mutating func shouldRetry(at now: TimeInterval) -> Bool {
        guard let expectedSince else { return false }
        let lastProgress = max(expectedSince, lastActivity ?? expectedSince, lastRetry ?? expectedSince)
        guard now - lastProgress >= timeout else { return false }
        // Rate-limit retries even when the device never produces its first packet.
        lastRetry = now
        return true
    }
}
