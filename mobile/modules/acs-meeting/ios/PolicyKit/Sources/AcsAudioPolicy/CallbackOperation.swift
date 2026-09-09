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
