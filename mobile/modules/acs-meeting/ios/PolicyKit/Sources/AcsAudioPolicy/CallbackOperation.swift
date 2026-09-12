import Foundation

/// Adapts ACS completion handlers to the session's serial control queue. Never
/// used on the main thread or the media path. Policy decisions must observe the
/// completed mute/stop result before deciding whether the microphone is safe.
public final class CallbackOperation<Value> {
  private let condition = NSCondition()
  private var result: Result<Value, Error>?
  private var expired = false

  public init() {}

  public func wait(
    timeout: TimeInterval = 30,
    onLateSuccess: @escaping (Value) -> Void = { _ in },
    start: (@escaping (Value?, Error?) -> Void) -> Void
  ) throws -> Value {
    precondition(!Thread.isMainThread, "ACS control operations must run on the session queue")
    let deadline = Date().addingTimeInterval(timeout)
    start { value, error in
      let outcome: Result<Value, Error> = if let error { .failure(error) }
      else if let value { .success(value) }
      else { .failure(CallbackOperationError.missingResult) }

      self.condition.lock()
      if self.expired {
        self.condition.unlock()
        if case let .success(value) = outcome { onLateSuccess(value) }
        return
      }
      if self.result == nil { self.result = outcome }
      self.condition.broadcast()
      self.condition.unlock()
    }

    condition.lock()
    defer { condition.unlock() }
    while result == nil {
      if !condition.wait(until: deadline), result == nil {
        expired = true
        throw CallbackOperationError.timedOut
      }
    }
    return try result!.get()
  }
}

public enum CallbackOperationError: Error {
  case missingResult
  case timedOut
}

/// Retires one call agent when hang-up completes or its deadline expires. The
/// session invokes finish on its serial queue; disposal must precede opening the
/// barrier, and a late SDK callback must not release a newer call's reservation.
final class CallAgentRetirement {
  private let group: DispatchGroup
  private var dispose: (() -> Void)?

  init(group: DispatchGroup, queue: DispatchQueue, timeout: TimeInterval = 10, dispose: @escaping () -> Void) {
    self.group = group
    self.dispose = dispose
    group.enter()
    queue.asyncAfter(deadline: .now() + timeout) { self.finish() }
  }

  func finish() {
    guard let dispose else { return }
    self.dispose = nil
    dispose()
    group.leave()
  }
}

/// Keeps an in-flight join's agent alive after cancellation until its returned
/// call is hung up. All methods run on the session queue, as do hang-up callbacks.
final class CallJoinRetirement<Call> {
  private let group: DispatchGroup
  private let queue: DispatchQueue
  private let timeout: TimeInterval
  private let dispose: () -> Void
  private let hangUp: (Call, @escaping () -> Void) -> Void
  private var retirement: CallAgentRetirement?
  private var completed = false

  init(group: DispatchGroup, queue: DispatchQueue, timeout: TimeInterval = 10,
       dispose: @escaping () -> Void, hangUp: @escaping (Call, @escaping () -> Void) -> Void)
  {
    self.group = group
    self.queue = queue
    self.timeout = timeout
    self.dispose = dispose
    self.hangUp = hangUp
  }

  func cancel() {
    guard !completed, retirement == nil else { return }
    retirement = CallAgentRetirement(group: group, queue: queue, timeout: timeout, dispose: dispose)
  }

  /// Returns true only when the session may adopt this join result.
  func receive(_ call: Call?) -> Bool {
    guard !completed else { return false }
    completed = true
    guard let retirement else { return true }
    if let call {
      hangUp(call) { self.queue.async { retirement.finish() } }
    } else { retirement.finish() }
    return false
  }
}
