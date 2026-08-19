package com.mentra.bluetoothsdk.sgcs

import java.util.Locale

/**
 * Temporarily suppresses phone heartbeats while BES OTA owns the ASG-to-BES UART.
 *
 * The lease is renewable so a lost terminal status cannot disable heartbeats permanently. It is
 * deliberately longer than ASG's 30-second BES response watchdog: after the lease expires, the
 * raw transfer has already completed or failed and ordinary UART liveness traffic is safe again.
 */
internal class BesOtaHeartbeatGuard(
    private val leaseDurationMs: Long = DEFAULT_LEASE_DURATION_MS,
) {
    @Volatile private var suppressionDeadlineMs = 0L

    init {
        require(leaseDurationMs > 0) { "leaseDurationMs must be positive" }
    }

    fun refresh(nowMs: Long) {
        suppressionDeadlineMs =
            if (nowMs > Long.MAX_VALUE - leaseDurationMs) Long.MAX_VALUE
            else nowMs + leaseDurationMs
    }

    fun clear() {
        suppressionDeadlineMs = 0L
    }

    fun observeOtaStatus(stepType: String, phase: String, status: String, nowMs: Long) {
        if (!stepType.equals("bes", ignoreCase = true) ||
            !phase.equals("install", ignoreCase = true)
        ) {
            return
        }

        when (status.lowercase(Locale.US)) {
            "failed", "complete", "step_complete", "finished", "success" -> clear()
            else -> refresh(nowMs)
        }
    }

    fun shouldSuppress(nowMs: Long): Boolean = nowMs < suppressionDeadlineMs

    companion object {
        internal const val DEFAULT_LEASE_DURATION_MS = 120_000L
    }
}
