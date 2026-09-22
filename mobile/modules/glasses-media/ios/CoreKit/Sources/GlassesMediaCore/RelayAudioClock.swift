import Foundation

/// A paced audio worker whose stop is a barrier for the final render callback and its resources.
public final class RelayAudioClock {
    private let condition = NSCondition()
    private var quitting = false
    private var exited = true
    private var enabled = false

    public init() {}

    public func start(render: @escaping (Double) -> Void, finish: @escaping () -> Void = {}) {
        condition.lock()
        precondition(exited, "Previous audio worker must stop before reinitialization")
        quitting = false; enabled = false; exited = false
        condition.unlock()
        let thread = Thread { [self] in
            defer {
                finish()
                condition.lock(); exited = true; condition.broadcast(); condition.unlock()
            }
            var sampleTime: Double = 0
            var next = ProcessInfo.processInfo.systemUptime
            while true {
                condition.lock()
                while !enabled && !quitting {
                    condition.wait(); next = ProcessInfo.processInfo.systemUptime
                }
                let stop = quitting
                condition.unlock()
                if stop { return }
                render(sampleTime)
                sampleTime += 480
                next += 0.01
                let now = ProcessInfo.processInfo.systemUptime
                if next > now { Thread.sleep(forTimeInterval: next - now) }
                else if now - next > 0.1 { next = now }
            }
        }
        thread.name = "Mentra glasses audio publish"
        thread.qualityOfService = .userInitiated
        thread.start()
    }

    public func setEnabled(_ value: Bool) {
        condition.lock(); enabled = value; condition.broadcast(); condition.unlock()
    }

    public func stop() {
        condition.lock(); quitting = true; enabled = false; condition.broadcast()
        while !exited {
            condition.wait()
        }
        condition.unlock()
    }
}
