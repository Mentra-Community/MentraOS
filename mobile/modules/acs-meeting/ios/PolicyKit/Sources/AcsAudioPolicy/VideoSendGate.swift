import Foundation

/// At most one retained video frame per stream generation, even if the SDK
/// stops completing sends. Old completions cannot release a new stream's frame.
public final class VideoSendGate {
  private let lock = NSLock()
  private var nextToken: UInt64 = 0
  private var pending: UInt64?

  public init() {}

  public func acquire() -> UInt64? {
    lock.lock()
    defer { lock.unlock() }
    guard pending == nil else { return nil }
    nextToken &+= 1
    pending = nextToken
    return nextToken
  }

  public func release(_ token: UInt64) {
    lock.lock()
    defer { lock.unlock() }
    if token == pending { pending = nil }
  }

  public func reset() {
    lock.lock()
    defer { lock.unlock() }
    pending = nil
  }
}
