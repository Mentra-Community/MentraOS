package com.mentra.glassesmedia.publisher

/** Gates JS microphone callbacks by attempt, without queueing audio behind network operations. */
class RelayPcmInput {
  private var attemptId: String? = null
  private var sink: ((ByteArray, Int, Int) -> Unit)? = null

  @Synchronized fun attach(id: String, target: (ByteArray, Int, Int) -> Unit) {
    attemptId = id
    sink = target
  }

  @Synchronized fun push(id: String, bytes: ByteArray, sampleRate: Int, channels: Int): Boolean {
    if (id != attemptId || bytes.isEmpty() || sampleRate !in 8_000..192_000 || channels !in 1..8) return false
    val target = sink ?: return false
    target(bytes, sampleRate, channels)
    return true
  }

  /** Wait for any in-flight push before the owner closes the publisher. */
  @Synchronized fun detach() {
    attemptId = null
    sink = null
  }
}
