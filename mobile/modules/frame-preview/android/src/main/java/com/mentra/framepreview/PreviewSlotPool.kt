package com.mentra.framepreview

/**
 * Send buffers for packed frames: a fixed number of exactly-sized slots.
 *
 * Slots are sized to one produced frame because `JavaScriptReplyProxy.postMessage(byte[])` sends
 * the whole array. They are replaced only when the produced size changes — a tier change, or the
 * source changing resolution — and never per frame. A replaced slot that a worker or the
 * transport still holds is retired rather than reused: its holder keeps the old array and its
 * later release is ignored, so a new frame can never be written over bytes still being read.
 */
class PreviewSlotPool(private val slotCount: Int = 2) {
  class Slot internal constructor(val bytes: ByteArray, internal val epoch: Int) {
    internal var inUse = false
    internal var sequence = -1
  }

  private var slots: Array<Slot> = emptyArray()
  private var epoch = 0

  /** Bytes per slot in the current epoch, or 0 before the first allocation. */
  var slotBytes = 0
    private set

  /** Times the slot set was replaced. Stays flat while the produced size is steady. */
  var reallocations = 0
    private set

  /** Allocate ahead of the first frame at a known size, off the pack path. */
  @Synchronized
  fun prepare(byteCount: Int) {
    if (byteCount > 0 && byteCount != slotBytes) reshape(byteCount)
  }

  /** A free slot of exactly [byteCount] bytes, or null when every slot is still held. */
  @Synchronized
  fun acquire(byteCount: Int, sequence: Int): Slot? {
    if (byteCount != slotBytes) reshape(byteCount)
    for (slot in slots) {
      if (!slot.inUse) {
        slot.inUse = true
        slot.sequence = sequence
        return slot
      }
    }
    return null
  }

  @Synchronized
  fun release(slot: Slot) {
    if (slot.epoch != epoch) return
    slot.inUse = false
    slot.sequence = -1
  }

  /** Free the slot carrying [sequence], if it belongs to the current epoch. */
  @Synchronized
  fun releaseSequence(sequence: Int) {
    for (slot in slots) {
      if (slot.sequence == sequence) {
        slot.inUse = false
        slot.sequence = -1
      }
    }
  }

  @Synchronized
  fun releaseAll() {
    for (slot in slots) {
      slot.inUse = false
      slot.sequence = -1
    }
  }

  @Synchronized
  fun heldCount(): Int = slots.count { it.inUse }

  private fun reshape(byteCount: Int) {
    epoch += 1
    val current = epoch
    slots = Array(slotCount) { Slot(ByteArray(byteCount), current) }
    slotBytes = byteCount
    reallocations += 1
  }
}
