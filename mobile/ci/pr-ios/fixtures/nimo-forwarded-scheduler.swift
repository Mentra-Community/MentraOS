import Foundation
import Dispatch

public final class DefaultTransport: @unchecked Sendable {
    private let queue: DispatchQueue
    public init(queue: DispatchQueue) {
        self.queue = queue
        queue.async { [weak self] in self?.serve() }
    }
    @inline(never) private func serve() { print("prototype default serve") }
}

public final class HelperDefaultTransport: @unchecked Sendable {
    private let queue: DispatchQueue
    public init(queue: DispatchQueue) {
        self.queue = queue
        enqueueServe()
    }
    @inline(never) private func enqueueServe() {
        queue.async { [weak self] in self?.serve() }
    }
    @inline(never) private func serve() { print("prototype helper default serve") }
}

public final class ExplicitTransport: @unchecked Sendable {
    private let queue: DispatchQueue
    public init(queue: DispatchQueue) {
        self.queue = queue
        enqueueServe()
    }
    @inline(never) private func enqueueServe() {
        let qos: DispatchQoS = .unspecified
        let flags = DispatchWorkItemFlags(rawValue: 0)
        queue.async(group: nil, qos: qos, flags: flags) { [weak self] in self?.serve() }
    }
    @inline(never) private func serve() { print("prototype explicit serve") }
}

public final class ForwardedTransport: @unchecked Sendable {
    private let queue: DispatchQueue
    public init(queue: DispatchQueue) {
        self.queue = queue
        let qos: DispatchQoS = .unspecified
        let flags = DispatchWorkItemFlags(rawValue: 0)
        enqueueServe(qos: qos, flags: flags)
    }
    @inline(never) private func enqueueServe(qos: DispatchQoS, flags: DispatchWorkItemFlags) {
        queue.async(group: nil, qos: qos, flags: flags) { [weak self] in self?.serve() }
    }
    @inline(never) private func serve() { print("prototype forwarded serve") }
}
