import Foundation

typealias NimoScheduler = (TimeInterval, @escaping () -> Void) -> () -> Void

/// All callers run on Main, including the injected scheduler and transport callbacks.
final class NimoCanvasCoordinator {
    private final class Flight {
        let key: Int
        var finalStarted = false
        var finalStartedElapsedMs: UInt64?
        var complete = false
        var earlyAck: (Data, UInt64?)?
        init(key: Int) {
            self.key = key
        }
    }

    private let continuousNow: (() -> UInt64)?
    private let schedule: NimoScheduler
    private let writeCapacity: () -> Int
    private let enqueue: ([Data], @escaping () -> Void, @escaping () -> Void) -> Bool
    private let reconnect: (String) -> Void
    private let rejected: (Int) -> Void
    private let result: (Int, Int) -> Void
    private let observedResult: (Int, Int, UInt64?) -> Void
    private let session = NimoCanvasSession()
    private var flight: Flight?
    private var cancelRetry: (() -> Void)?
    private var cancelDeadline: (() -> Void)?

    init(schedule: @escaping NimoScheduler, writeCapacity: @escaping () -> Int,
         enqueue: @escaping ([Data], @escaping () -> Void, @escaping () -> Void) -> Bool,
         reconnect: @escaping (String) -> Void, rejected: @escaping (Int) -> Void, result: @escaping (Int, Int) -> Void = { _, _ in }, observedResult: @escaping (Int, Int, UInt64?) -> Void = { _, _, _ in }, continuousNow: (() -> UInt64)? = nil)
    {
        self.continuousNow = continuousNow
        self.schedule = schedule; self.writeCapacity = writeCapacity; self.enqueue = enqueue
        self.reconnect = reconnect; self.rejected = rejected; self.result = result; self.observedResult = observedResult
    }

    func offer(_ bytes: Data, scope: String, force: Bool = false) {
        run(session.offer(bytes, scope: scope, force: force))
    }

    func activate() {
        run(session.activate())
    }

    func readiness(_ value: Bool, confirmed: Bool = false) {
        if !value { cancelRetry?(); cancelRetry = nil }
        run(session.readiness(value, confirmed: confirmed))
    }

    func exit() {
        cancelRetry?(); cancelRetry = nil
        run(session.exit())
    }

    func nativeApp(_ appId: Int, entered: Bool) {
        run(session.nativeApp(appId, entered: entered))
    }

    func disconnected() {
        cancelRetry?(); cancelRetry = nil
        cancelDeadline?(); cancelDeadline = nil
        flight = nil
        session.disconnected()
    }

    func response(key: Int, payload: Data, receivedElapsedMs: UInt64? = nil) {
        guard let current = flight, session.acceptsResponse(key: key, payload: payload) else { return }
        if let receivedElapsedMs, let started = current.finalStartedElapsedMs, receivedElapsedMs < started { return }
        if !current.complete {
            if current.finalStarted, current.earlyAck == nil { current.earlyAck = (payload, receivedElapsedMs) }
            return
        }
        cancelDeadline?(); cancelDeadline = nil
        flight = nil
        let actions = session.response(key: key, payload: payload)
        result(key, Int(payload.first ?? 255))
        observedResult(key, Int(payload.first ?? 255), receivedElapsedMs)
        run(actions)
    }

    var pendingCount: Int { (flight == nil ? 0 : 1) + (cancelRetry == nil ? 0 : 1) }
    var mayHaveEntered: Bool { session.mayHaveEntered }

    private func run(_ actions: [NimoCanvasSession.Action]) {
        for action in actions {
            switch action {
            case let .send(key, frame, ticket):
                cancelRetry?(); cancelRetry = nil
                cancelDeadline?()
                let current = Flight(key: key)
                flight = current
                cancelDeadline = schedule(45) { [weak self] in
                    guard let self, self.flight === current else { return }
                    self.run(self.session.timeout(ticket))
                }
                do {
                    let frames = try NimoCanvasCodec.frames(key: key, content: frame, writeCapacity: writeCapacity())
                    let queued = enqueue(frames, { [weak self] in
                        if let self, self.flight === current { current.finalStarted = true; current.finalStartedElapsedMs = self.continuousNow?() }
                    }, { [weak self] in
                        guard let self, self.flight === current else { return }
                        current.complete = true
                        if let ack = current.earlyAck { self.response(key: key, payload: ack.0, receivedElapsedMs: ack.1) }
                    })
                    if !queued, flight === current { disconnected(); reconnect("Canvas transport unavailable") }
                } catch {
                    disconnected(); reconnect("Canvas framing failed: \(error)")
                }
            case let .reconnect(reason): disconnected(); reconnect(reason)
            case let .rejected(status):
                rejected(status)
                if status == 7 {
                    cancelRetry?()
                    cancelRetry = schedule(1) { [weak self] in
                        guard let self else { return }
                        self.cancelRetry = nil
                        self.run(self.session.retryNotReady())
                    }
                }
            }
        }
    }
}

/// Serializes characteristic writes. A missing callback retires the link instead
/// of allowing a late callback to acknowledge a different fragment.
final class NimoWriteQueue<Characteristic: AnyObject> {
    private final class Write {
        let characteristic: Characteristic
        let bytes: Data
        let started: () -> Void
        let completed: () -> Void
        var callbackReceived = false
        init(_ characteristic: Characteristic, _ bytes: Data, _ started: @escaping () -> Void, _ completed: @escaping () -> Void) {
            self.characteristic = characteristic; self.bytes = bytes; self.started = started; self.completed = completed
        }
    }

    private let schedule: NimoScheduler
    private let write: (Characteristic, Data) -> Bool
    private let failure: (String) -> Void
    private var connection: AnyObject?
    private var generation: UInt64 = 0
    private var queue: [Write] = []
    private var current: Write?
    private var outstanding: [(AnyObject, Characteristic)] = []
    private var scheduledCompletions = 0
    var activeCount: Int { outstanding.count + scheduledCompletions }
    var queuedCount: Int { queue.count }
    func connectionClosed(_ closed: AnyObject) { outstanding.removeAll { $0.0 === closed } }
    private var cancelDeadline: (() -> Void)?

    init(schedule: @escaping NimoScheduler, write: @escaping (Characteristic, Data) -> Bool, failure: @escaping (String) -> Void) {
        self.schedule = schedule; self.write = write; self.failure = failure
    }

    func connected(_ connection: AnyObject) {
        reset(); self.connection = connection
    }

    func reset() {
        generation &+= 1
        connection = nil; current = nil; queue.removeAll()
        cancelDeadline?(); cancelDeadline = nil
    }

    @discardableResult
    func enqueue(_ connection: AnyObject, characteristic: Characteristic, frames: [Data],
                 finalStarted: @escaping () -> Void = {}, completed: @escaping () -> Void = {}) -> Bool
    {
        guard connection === self.connection, !frames.isEmpty else { return false }
        guard queue.count + frames.count <= 1100 else { fail("Fragment chain exceeds write budget"); return false }
        for (i, frame) in frames.enumerated() {
            let last = i == frames.count - 1
            queue.append(Write(characteristic, frame, last ? finalStarted : {}, last ? completed : {}))
        }
        drain()
        return true
    }

    func written(_ connection: AnyObject, characteristic: Characteristic, success: Bool) {
        if let index = outstanding.firstIndex(where: { $0.0 === connection && $0.1 === characteristic }) { outstanding.remove(at: index) }
        guard connection === self.connection, let item = current,
              characteristic === item.characteristic, !item.callbackReceived else { return }
        item.callbackReceived = true
        cancelDeadline?(); cancelDeadline = nil
        guard success else { fail("GATT write failed"); return }
        let expected = generation
        scheduledCompletions += 1
        _ = schedule(0.005) { [weak self] in
            guard let self else { return }
            self.scheduledCompletions -= 1
            guard self.generation == expected, self.current === item else { return }
            self.current = nil
            item.completed()
            self.drain()
        }
    }

    private func drain() {
        guard connection != nil, current == nil, !queue.isEmpty else { return }
        let item = queue.removeFirst()
        current = item
        let expected = generation
        guard write(item.characteristic, item.bytes) else { fail("GATT transport unavailable"); return }
        outstanding.append((connection!, item.characteristic))
        item.started()
        cancelDeadline = schedule(3) { [weak self] in
            guard let self, self.generation == expected, self.current === item, !item.callbackReceived else { return }
            self.fail("GATT write timed out")
        }
    }

    private func fail(_ reason: String) {
        reset(); failure(reason)
    }
}

/// Coalesces pending encodes and fences running results on scene change, Exit and disconnect.
final class NimoCanvasEncoder {
    private final class Work {
        enum Stage { case queued, worker, delivery, settled }
        var stage = Stage.queued
        var cancelled = false
    }
    private let worker: NimoScheduler
    private let main: NimoScheduler
    private let failure: (Error) -> Void
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var jobs: [Work] = []
    var workerCount: Int { lock.lock(); defer { lock.unlock() }; return jobs.filter { $0.stage == .queued || $0.stage == .worker }.count }
    var deliveryCount: Int { lock.lock(); defer { lock.unlock() }; return jobs.filter { $0.stage == .delivery }.count }

    init(main: @escaping NimoScheduler, worker: @escaping NimoScheduler, failure: @escaping (Error) -> Void) {
        self.main = main; self.worker = worker; self.failure = failure
    }

    func submit(encode: @escaping () throws -> Data, deliver: @escaping (Data) -> Void) {
        invalidate()
        let expected = generation, job = Work()
        lock.lock(); jobs.append(job); lock.unlock()
        _ = worker(0) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            guard job.stage == .queued else { self.lock.unlock(); return }
            let shouldEncode = !job.cancelled
            job.stage = .worker; self.lock.unlock()
            let result: Result<Data, Error>? = shouldEncode ? Result { try encode() } : nil
            self.lock.lock(); job.stage = .delivery; self.lock.unlock()
            _ = self.main(0) { [weak self] in
                guard let self else { return }
                self.lock.lock(); job.stage = .settled; self.jobs.removeAll { $0 === job }; self.lock.unlock()
                guard self.generation == expected else { return }
                guard let result else { return }
                switch result {
                case let .success(bytes): deliver(bytes)
                case let .failure(error): self.failure(error)
                }
            }
        }
    }

    func invalidate() {
        generation &+= 1
        lock.lock()
        for job in jobs where job.stage == .queued { job.cancelled = true }
        lock.unlock()
        // Do not erase queued producers: their no-op worker and Main delivery
        // fences must actually execute before teardown can report settlement.
    }
}
