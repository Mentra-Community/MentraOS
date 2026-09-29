package com.mentra.glassesmedia.source

import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap

/**
 * Stills the glasses upload to the phone's ingest listener during a Direct-link call.
 *
 * A still is only accepted for a request id the host registered with [expect] before it asked the
 * glasses to shoot, so nothing else on the hotspot can push an image onto the outgoing Teams tile.
 * Process-wide because the listener is rebuilt on every SoftAP recovery while the photo request
 * belongs to the meeting.
 */
object StillPhotoInbox {

  /** Largest still accepted. A full-size Mentra Live JPEG is 1-3 MB. */
  const val MAX_BYTES = 16L * 1024 * 1024

  private val pending = ConcurrentHashMap<String, CompletableFuture<ByteArray>>()

  /** Register [requestId]. Replaces an earlier registration of the same id. */
  fun expect(requestId: String): CompletableFuture<ByteArray> {
    val future = CompletableFuture<ByteArray>()
    pending.put(requestId, future)?.cancel(false)
    return future
  }

  /** True when a POST for [requestId] should be read. */
  fun isExpected(requestId: String): Boolean = pending[requestId]?.isDone == false

  /** Hand over a still. False when nothing is waiting for [requestId]. */
  fun deliver(requestId: String, bytes: ByteArray): Boolean {
    val future = pending[requestId] ?: return false
    return future.complete(bytes)
  }

  /** The registration for [requestId], if any. */
  fun lookup(requestId: String): CompletableFuture<ByteArray>? = pending[requestId]

  /** Forget [requestId]; a waiter sees cancellation. */
  fun cancel(requestId: String) {
    pending.remove(requestId)?.cancel(false)
  }

  /** Leave, End, or a new join. */
  fun cancelAll() {
    val all = pending.keys.toList()
    all.forEach { cancel(it) }
  }
}
