package com.mentra.acsmeeting.video

import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Single in-flight send. No time gate: every unique frame reaches ACS unless
 * the previous send is still running. [busyCount] is the only backpressure signal.
 */
class SendGate {
  private val sending = AtomicBoolean(false)
  private val busy = AtomicInteger(0)

  fun tryAcquire(): Boolean {
    if (sending.compareAndSet(false, true)) return true
    busy.incrementAndGet()
    return false
  }

  fun release() {
    sending.set(false)
  }

  fun busyCount(): Int = busy.get()

  fun isHeld(): Boolean = sending.get()
}
