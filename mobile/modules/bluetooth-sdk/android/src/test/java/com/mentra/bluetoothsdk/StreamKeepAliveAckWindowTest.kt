package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class StreamKeepAliveAckWindowTest {
    @Test
    fun lateAckWithinWindowResetsMissCount() {
        val window = StreamKeepAliveAckWindow(maxTrackedAckIds = 3, maxMissedAcks = 3)
        window.arm()
        window.recordSent("ack-1")

        assertThat(window.recordTick()).isNull()
        window.recordSent("ack-2")

        assertThat(window.acknowledge("ack-1")).isTrue()
        assertThat(window.missedAckCount).isZero()
        assertThat(window.acknowledge("ack-2")).isTrue()
    }

    @Test
    fun oneIntervalLateAcksNeverReachTimeout() {
        val window = StreamKeepAliveAckWindow(maxTrackedAckIds = 3, maxMissedAcks = 3)
        window.arm()
        window.recordSent("ack-1")

        for (sequence in 2..6) {
            assertThat(window.recordTick()).isNull()
            window.recordSent("ack-$sequence")
            assertThat(window.acknowledge("ack-${sequence - 1}")).isTrue()
            assertThat(window.missedAckCount).isZero()
        }
    }

    @Test
    fun newerAckDiscardsOlderOutstandingRequests() {
        val window = StreamKeepAliveAckWindow(maxTrackedAckIds = 3, maxMissedAcks = 3)
        window.arm()
        window.recordSent("ack-1")
        window.recordSent("ack-2")

        assertThat(window.acknowledge("ack-2")).isTrue()
        assertThat(window.acknowledge("ack-1")).isFalse()
        assertThat(window.recordTick()).isNull()
    }

    @Test
    fun timeoutReportsOnceButKeepsAcceptingAcks() {
        val window = StreamKeepAliveAckWindow(maxTrackedAckIds = 3, maxMissedAcks = 3)
        window.arm()

        window.recordSent("ack-1")
        assertThat(window.recordTick()).isNull()
        window.recordSent("ack-2")
        assertThat(window.recordTick()).isNull()
        window.recordSent("ack-3")
        assertThat(window.recordTick()).isEqualTo(3)
        window.recordSent("ack-4")

        assertThat(window.recordTick()).isNull()
        assertThat(window.acknowledge("ack-2")).isTrue()
        assertThat(window.missedAckCount).isZero()
    }

    @Test
    fun requestsOutsideBoundedWindowAreRejected() {
        val window = StreamKeepAliveAckWindow(maxTrackedAckIds = 2, maxMissedAcks = 3)
        window.arm()
        window.recordSent("ack-1")
        window.recordSent("ack-2")
        window.recordSent("ack-3")

        assertThat(window.acknowledge("ack-1")).isFalse()
        assertThat(window.acknowledge("ack-2")).isTrue()
    }
}
