package com.mentra.bluetoothsdk

import android.os.SystemClock

/**
 * Bounds how many native log lines per second the module hands to the JavaScript runtime.
 *
 * Every event the module emits pins a JNI global reference until the JavaScript thread
 * drains it, and the process-wide table holds about 51,200 references. Native code can log
 * faster than a busy JavaScript thread drains, so an unbounded log stream aborts the process
 * instead of merely lagging. Lines over the budget are withheld from JavaScript only; the
 * native console still has every one of them. The first line forwarded after a shortfall
 * reports how many were withheld, so the gap is visible in the JavaScript stream.
 */
internal class LogForwardingBudget(
    val maxPerWindow: Int = DEFAULT_MAX_PER_SECOND,
    private val windowMs: Long = 1_000L,
    private val clock: () -> Long = SystemClock::elapsedRealtime,
) {
    private var windowEndsAtMs = Long.MIN_VALUE
    private var forwardedInWindow = 0
    private var withheld = 0

    /**
     * Returns null when the current line must be withheld, otherwise the number of lines
     * withheld since the previous forwarded one (zero in steady state).
     */
    @Synchronized
    fun admit(): Int? {
        val now = clock()
        if (now >= windowEndsAtMs) {
            windowEndsAtMs = now + windowMs
            forwardedInWindow = 0
        }
        if (forwardedInWindow >= maxPerWindow) {
            withheld++
            return null
        }
        forwardedInWindow++
        return withheld.also { withheld = 0 }
    }

    companion object {
        /**
         * Far above the SDK's steady-state diagnostic rate, and low enough that even a
         * JavaScript thread stalled for minutes cannot exhaust the reference table.
         */
        const val DEFAULT_MAX_PER_SECOND = 100
    }
}
