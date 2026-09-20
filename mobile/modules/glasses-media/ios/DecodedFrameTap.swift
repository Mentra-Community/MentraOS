import CoreVideo
import Foundation

/// A second, optional consumer of decoded glasses video, sitting beside the ACS sender.
///
/// The call owns this pipeline; the preview is a guest. So `offer` never blocks, never throws
/// into its caller, and never does real work — a sink may only decide whether it wants the frame,
/// retain it, and schedule bounded work elsewhere. A preview that crashes, stalls, or falls
/// behind must cost the call nothing.
///
/// Detach is generation-checked because sessions overlap: a call ending late must not tear down
/// the subscription a newer call already installed.
public final class DecodedFrameTap {
  public static let shared = DecodedFrameTap()

  private let lock = NSLock()
  private var sink: ((CVPixelBuffer) -> Void)?
  private var generation: UInt64 = 0

  public init() {}

  /// Install the preview sink and return the generation that owns it.
  @discardableResult
  public func attach(_ sink: @escaping (CVPixelBuffer) -> Void) -> UInt64 {
    lock.lock()
    defer { lock.unlock() }
    generation &+= 1
    self.sink = sink
    return generation
  }

  /// Remove the sink only if it is still the one this generation installed.
  public func detach(generation: UInt64) {
    lock.lock()
    defer { lock.unlock() }
    guard generation == self.generation else { return }
    sink = nil
  }

  public var hasSink: Bool {
    lock.lock()
    defer { lock.unlock() }
    return sink != nil
  }

  /// Called on the decoder's thread, immediately before the frame goes to ACS.
  public func offer(_ buffer: CVPixelBuffer) {
    lock.lock()
    let sink = self.sink
    lock.unlock()
    guard let sink else { return }
    sink(buffer)
  }
}
