import Foundation

typealias NimoScheduler = (TimeInterval, @escaping () -> Void) -> () -> Void

/// All callers run on Main, including the injected scheduler and transport callbacks.
final class NimoCanvasCoordinator {
    private final class Flight {
        let key: Int
        var finalStarted = false
        var complete = false
        var earlyAck: Data?
        init(key: Int) {
            self.key = key
        }
    }

    private let schedule: NimoScheduler
    private let writeCapacity: () -> Int
    private let enqueue: ([Data], @escaping () -> Void, @escaping () -> Void) -> Bool
    private let reconnect: (String) -> Void
    private let rejected: (Int) -> Void
    private let session = NimoCanvasSession()
    private var flight: Flight?
    private var cancelDeadline: (() -> Void)?

    init(schedule: @escaping NimoScheduler, writeCapacity: @escaping () -> Int,
         enqueue: @escaping ([Data], @escaping () -> Void, @escaping () -> Void) -> Bool,
         reconnect: @escaping (String) -> Void, rejected: @escaping (Int) -> Void)
    {
        self.schedule = schedule; self.writeCapacity = writeCapacity; self.enqueue = enqueue
        self.reconnect = reconnect; self.rejected = rejected
    }

    func offer(_ bytes: Data, scope: String, force: Bool = false) {
        run(session.offer(bytes, scope: scope, force: force))
    }

    func readiness(_ value: Bool, confirmed: Bool = false) {
        run(session.readiness(value, confirmed: confirmed))
    }

    func exit() {
        run(session.exit())
    }

    /// An expected Exit report must not discard a newer host encode queued behind Exit.
    func nativeApp(_ appId: Int, entered: Bool) -> Bool {
        let takeover = (appId == NimoCanvasCodec.appId && !entered) || (appId != NimoCanvasCodec.appId && entered)
        let expectedExit = appId == NimoCanvasCodec.appId && !entered && flight?.key == 3
        run(session.nativeApp(appId, entered: entered))
        return takeover && !expectedExit
    }

    func disconnected() {
        cancelDeadline?(); cancelDeadline = nil
        flight = nil
        session.disconnected()
    }

    func response(key: Int, payload: Data) {
        guard let current = flight, session.acceptsResponse(key: key, payload: payload) else { return }
        if !current.complete {
            if current.finalStarted, current.earlyAck == nil { current.earlyAck = payload }
            return
        }
        cancelDeadline?(); cancelDeadline = nil
        flight = nil
        run(session.response(key: key, payload: payload))
    }

    private func run(_ actions: [NimoCanvasSession.Action]) {
        for action in actions {
            switch action {
            case let .send(key, frame, ticket):
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
                        if self?.flight === current { current.finalStarted = true }
                    }, { [weak self] in
                        guard let self, self.flight === current else { return }
                        current.complete = true
                        if let ack = current.earlyAck { self.response(key: key, payload: ack) }
                    })
                    if !queued, flight === current { disconnected(); reconnect("Canvas transport unavailable") }
                } catch {
                    disconnected(); reconnect("Canvas framing failed: \(error)")
                }
            case let .reconnect(reason): disconnected(); reconnect(reason)
            case let .rejected(status): rejected(status)
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
    private var cancelDeadline: (() -> Void)?

    var isIdle: Bool {
        connection != nil && current == nil && queue.isEmpty
    }

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
        guard connection === self.connection, let item = current,
              characteristic === item.characteristic, !item.callbackReceived else { return }
        item.callbackReceived = true
        cancelDeadline?(); cancelDeadline = nil
        guard success else { fail("GATT write failed"); return }
        let expected = generation
        _ = schedule(0.005) { [weak self] in
            guard let self, self.generation == expected, self.current === item else { return }
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
    private let worker: NimoScheduler
    private let main: NimoScheduler
    private let failure: (Error) -> Void
    private var generation: UInt64 = 0
    private var cancelPending: (() -> Void)?

    init(main: @escaping NimoScheduler, worker: @escaping NimoScheduler, failure: @escaping (Error) -> Void) {
        self.main = main; self.worker = worker; self.failure = failure
    }

    /// submit/invalidate and delivery run on Main; the worker only reads its captured request.
    func submit(encode: @escaping () throws -> Data, deliver: @escaping (Data) -> Void) {
        invalidate()
        let expected = generation
        cancelPending = worker(0) { [weak self] in
            let result = Result { try encode() }
            guard let self else { return }
            _ = self.main(0) { [weak self] in
                guard let self, self.generation == expected else { return }
                self.cancelPending = nil
                switch result {
                case let .success(bytes): deliver(bytes)
                case let .failure(error): self.failure(error)
                }
            }
        }
    }

    func invalidate() {
        generation &+= 1; cancelPending?(); cancelPending = nil
    }
}
