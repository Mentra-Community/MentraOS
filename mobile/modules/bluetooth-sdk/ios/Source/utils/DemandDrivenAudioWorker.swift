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
            lock.unlock()
        }
    }
}
