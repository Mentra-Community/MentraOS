import Foundation

/// Owns a processor on one serial queue. Empty queues schedule no recurring work.
/// Demand changes invalidate queued audio/results immediately; creation, processing,
/// and destruction finish in order without blocking the caller (including the UI).
final class DemandDrivenAudioWorker<Processor> {
    struct Snapshot {
        let active: Bool
        let initialized: Bool
        let processing: Bool
        let queuedBuffers: Int
        let processedBuffers: UInt64
        let droppedBuffers: UInt64
    }

    private let lock = NSLock()
    private let queue: DispatchQueue
    private let capacity: Int
    private let makeProcessor: () -> Processor?
    private let process: (Processor, Data, UInt64) -> Void
    private var active = false
    private var generation: UInt64 = 0
    private var buffers = [Data]()
    private var scheduled = false
    private var initialized = false
    private var processing = false
    private var processedBuffers: UInt64 = 0
    private var droppedBuffers: UInt64 = 0

    // Accessed only on queue, including release of the previous processor.
    private var processor: Processor?
    private var processorGeneration: UInt64?
    private var attemptedInitialization = false
    /// Control operations queued behind audio; while any wait, `drain` yields after each buffer.
    private var pendingControlOperations = 0

    init(capacity: Int = 100,
         queue: DispatchQueue = DispatchQueue(label: "com.mentra.speech.processor", qos: .userInitiated),
         makeProcessor: @escaping () -> Processor?,
         process: @escaping (Processor, Data, UInt64) -> Void)
    {
        precondition(capacity > 0)
        self.capacity = capacity
        self.queue = queue
        self.makeProcessor = makeProcessor
        self.process = process
    }

    func setActive(_ value: Bool) {
        lock.lock()
        defer { lock.unlock() }
        guard active != value else { return }
        active = value
        invalidateLocked()
    }

    /// Reload a changed model only if there is still local-transcription demand.
    func restart() {
        lock.lock()
        defer { lock.unlock() }
        invalidateLocked()
    }

    private func invalidateLocked() {
        generation &+= 1
        buffers.removeAll(keepingCapacity: true)
        initialized = false
        scheduleLocked()
    }

    func accept(_ data: Data) {
        guard !data.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        guard active else { return }
        // Bound even audio arriving while model loading or decoding is blocked.
        if buffers.count == capacity {
            buffers.removeFirst()
            droppedBuffers &+= 1
        }
        buffers.append(data)
        scheduleLocked()
    }

    func isCurrent(_ token: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return active && generation == token
    }

    /// Outcome of the processor load for the current demand.
    enum LoadState: Equatable {
        /// No demand, so nothing is loaded and nothing needs to be.
        case noDemand
        case loaded
        case failed
    }

    /// Serialize control operations with inference without enabling audio demand.
    func perform<T>(_ operation: @escaping () -> T) async -> T {
        await withCheckedContinuation { continuation in
            lock.lock()
            pendingControlOperations += 1
            lock.unlock()
            queue.async {
                self.lock.lock()
                self.pendingControlOperations -= 1
                self.lock.unlock()
                continuation.resume(returning: operation())
            }
        }
    }

    /// Run `operation` on the worker queue, after audio already queued, with the processor of the
    /// current demand. Returns nil without running it when there is no demand or no processor.
    func withCurrentProcessor<T>(_ operation: @escaping (Processor, UInt64) -> T) async -> T? {
        await perform {
            self.lock.lock()
            let token = self.generation
            let current = self.active && self.processorGeneration == token
            self.lock.unlock()
            guard current, let processor = self.processor else { return nil }
            return operation(processor, token)
        }
    }

    /// Wait until the processor for the current demand has been created (or failed to be).
    /// Returns immediately when there is no demand.
    func awaitLoad() async -> LoadState {
        while true {
            guard snapshot().active else { return .noDemand }
            // A drain is already scheduled ahead of this block whenever demand changed, so
            // the state seen here is settled unless demand changed again in the meantime.
            let state: LoadState? = await perform {
                self.lock.lock()
                defer { self.lock.unlock() }
                guard self.active else { return .noDemand }
                guard self.processorGeneration == self.generation, self.attemptedInitialization else { return nil }
                return self.processor == nil ? .failed : .loaded
            }
            if let state { return state }
        }
    }

    /// Reload the processor if there is demand, and wait for the result.
    func restartAndAwaitLoad() async -> LoadState {
        restart()
        return await awaitLoad()
    }

    /// Turn demand on and wait for the load. Enabling again while a failed load is cached is a
    /// retry, so it loads once more; enabling a loaded or loading processor changes nothing.
    func activateAndAwaitLoad() async -> LoadState {
        let wasActive = snapshot().active
        setActive(true)
        let state = await awaitLoad()
        guard state == .failed, wasActive else { return state }
        return await restartAndAwaitLoad()
    }

    func snapshot() -> Snapshot {
        lock.lock()
        defer { lock.unlock() }
        return Snapshot(active: active, initialized: initialized, processing: processing,
                        queuedBuffers: buffers.count, processedBuffers: processedBuffers,
                        droppedBuffers: droppedBuffers)
    }

    private func scheduleLocked() {
        guard !scheduled else { return }
        scheduled = true
        queue.async { self.drain() }
    }

    private func drain() {
        while true {
            lock.lock()
            let token = generation
            if processorGeneration != token {
                lock.unlock()
                // ARC destruction stays serialized with inference and model loading.
                processor = nil
                processorGeneration = token
                attemptedInitialization = false
                continue
            }
            guard active else {
                scheduled = false
                lock.unlock()
                return
            }
            if !attemptedInitialization {
                attemptedInitialization = true
                lock.unlock()
                processor = makeProcessor()
                lock.lock()
                if generation == token { initialized = processor != nil }
                lock.unlock()
                continue
            }
            guard let processor else {
                buffers.removeAll(keepingCapacity: true)
                scheduled = false
                lock.unlock()
                return // Missing model: retry on a demand transition or model restart.
            }
            guard !buffers.isEmpty else {
                scheduled = false
                lock.unlock()
                return
            }
            let data = buffers.removeFirst()
            processing = true
            lock.unlock()
            process(processor, data, token)
            lock.lock()
            processedBuffers &+= 1
            processing = false
            // When inference can't keep up, audio never runs out. Yield to a waiting control
            // operation (a load wait, a flush) instead of starving it.
            if pendingControlOperations > 0, !buffers.isEmpty {
                lock.unlock()
                queue.async { self.drain() }
                return
            }
            lock.unlock()
        }
    }
}
