package com.mentra.glassesmedia.source

/**
 * Gives a transient ICE `DISCONNECTED` time to heal before it fails a source.
 *
 * libwebrtc reports DISCONNECTED as soon as consent checks stop being answered, and routinely
 * returns to CONNECTED on its own once packets flow again. On the glasses hotspot that is exactly
 * what a Wi-Fi hiccup or the glasses' own publisher reconnect looks like. Only `FAILED` is final.
 * The phone-side publisher already waits [GRACE_MS] on DISCONNECTED; the receiver must not be
 * stricter than the sender it is paired with.
 *
 * Free of `org.webrtc` and Android types so it is unit testable: the owner supplies the timer.
 */
internal class IceDisconnectGrace(
  private val graceMs: Long = GRACE_MS,
  private val schedule: (Runnable, Long) -> Unit,
  private val cancelScheduled: (Runnable) -> Unit,
  private val onExpired: () -> Unit,
) {
  private var pending: Runnable? = null

  val isWaiting: Boolean
    @Synchronized get() = pending != null

  /** DISCONNECTED: start the clock once; a second DISCONNECTED does not extend it. */
  @Synchronized
  fun onDisconnected() {
    if (pending != null) return
    val task = object : Runnable {
      override fun run() {
        synchronized(this@IceDisconnectGrace) {
          if (pending !== this) return
          pending = null
        }
        onExpired()
      }
    }
    pending = task
    schedule(task, graceMs)
  }

  /** CONNECTED, COMPLETED, FAILED, or a torn-down peer: nothing left to wait for. */
  @Synchronized
  fun clear() {
    pending?.let(cancelScheduled)
    pending = null
  }

  companion object {
    /** Same allowance as `PhoneWhipPublisher`'s disconnect deadline. */
    const val GRACE_MS = 10_000L
  }
}
