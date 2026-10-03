import Foundation

/// One preallocated send buffer. Freed when the last reference goes, so a transport that still
/// holds a slot (through its send completion) keeps the memory alive after the pool replaced it.
public final class PreviewSlot {
  public let buffer: UnsafeMutableRawBufferPointer
  fileprivate let epoch: Int
  fileprivate var inUse = false
  fileprivate var sequence: UInt32?

  fileprivate init(byteCount: Int, epoch: Int) {
    buffer = UnsafeMutableRawBufferPointer.allocate(byteCount: byteCount, alignment: 16)
    self.epoch = epoch
  }

  public var byteCount: Int { buffer.count }

  deinit { buffer.deallocate() }
}

/// Send buffers for packed frames: a fixed number of slots sized to the produced frame.
///
/// Slots are replaced only when the produced size changes — a tier change, or the source changing
/// resolution — and never per frame. A replaced slot still held by the worker or the transport is
/// retired rather than reused: its holder keeps the old memory, its late release is ignored, and
/// a new frame is never written over bytes still being read.
public final class PreviewSlotPool {
  private let slotCount: Int
  private var slots: [PreviewSlot] = []
  private var epoch = 0
  public private(set) var slotBytes = 0
  public private(set) var reallocations = 0

  public init(slotCount: Int = 2) {
    self.slotCount = max(slotCount, 1)
  }

  /// Allocate ahead of the first frame at a known size, off the pack path.
  public func prepare(byteCount: Int) {
    if byteCount > 0, byteCount != slotBytes { reshape(byteCount) }
  }

  /// A free slot of `byteCount` bytes, or nil when every slot is still held.
  public func acquire(byteCount: Int, sequence: UInt32) -> PreviewSlot? {
    if byteCount != slotBytes { reshape(byteCount) }
    for slot in slots where !slot.inUse {
      slot.inUse = true
      slot.sequence = sequence
      return slot
    }
    return nil
  }

  public func release(_ slot: PreviewSlot) {
    guard slot.epoch == epoch else { return }
    slot.inUse = false
    slot.sequence = nil
  }

  public func releaseAll() {
    for slot in slots {
      slot.inUse = false
      slot.sequence = nil
    }
  }

  public var heldCount: Int { slots.filter(\.inUse).count }

  private func reshape(_ byteCount: Int) {
    epoch += 1
    let current = epoch
    slots = (0 ..< slotCount).map { _ in PreviewSlot(byteCount: byteCount, epoch: current) }
    slotBytes = byteCount
    reallocations += 1
  }
}
