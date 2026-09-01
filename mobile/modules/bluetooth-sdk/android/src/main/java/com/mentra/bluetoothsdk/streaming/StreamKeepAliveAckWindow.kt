package com.mentra.bluetoothsdk

import java.util.ArrayDeque

/**
 * Tracks a bounded, ordered window of stream keep-alive requests.
 *
 * ACKs can arrive after a newer request has already been sent. Matching any request still in the
 * window proves that the stream transport is responsive; requests older than the match can then be
 * discarded as stale.
 */
internal class StreamKeepAliveAckWindow(
    private val maxTrackedAckIds: Int,
    private val maxMissedAcks: Int,
) {
    private val pendingAckIds = ArrayDeque<String>()
    var missedAckCount: Int = 0
        private set
    var armed: Boolean = false
        private set
    private var didReportTimeout = false

    init {
        require(maxTrackedAckIds > 0)
        require(maxMissedAcks > 0)
    }

    fun arm() {
        armed = true
        resetPendingState()
    }

    fun recordSent(ackId: String) {
        pendingAckIds.remove(ackId)
        pendingAckIds.addLast(ackId)
        while (pendingAckIds.size > maxTrackedAckIds) {
            pendingAckIds.removeFirst()
        }
    }

    /** Returns the miss count once, when the reporting threshold is first reached. */
    fun recordTick(): Int? {
        if (!armed || pendingAckIds.isEmpty()) return null
        missedAckCount += 1
        if (missedAckCount < maxMissedAcks || didReportTimeout) return null
        didReportTimeout = true
        return missedAckCount
    }

    fun acknowledge(ackId: String): Boolean {
        if (!pendingAckIds.contains(ackId)) return false
        while (pendingAckIds.isNotEmpty()) {
            if (pendingAckIds.removeFirst() == ackId) break
        }
        missedAckCount = 0
        didReportTimeout = false
        return true
    }

    private fun resetPendingState() {
        pendingAckIds.clear()
        missedAckCount = 0
        didReportTimeout = false
    }
}
