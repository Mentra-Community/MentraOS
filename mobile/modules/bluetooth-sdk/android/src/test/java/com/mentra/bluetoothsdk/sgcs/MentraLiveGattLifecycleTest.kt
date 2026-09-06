package com.mentra.bluetoothsdk.sgcs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MentraLiveGattLifecycleTest {
    @Test
    fun `replacement connection waits for disconnect completion`() {
        val barrier = MentraLiveGattTeardownBarrier()
        val events = mutableListOf<String>()
        val teardown = barrier.beginTeardown()

        assertTrue(barrier.deferUntilIdle { events.add("connect") })
        assertEquals(emptyList<String>(), events)

        events.add("disconnect")
        barrier.completeTeardown(teardown)

        assertEquals(listOf("disconnect", "connect"), events)
    }

    @Test
    fun `all active teardowns must finish before connections resume`() {
        val barrier = MentraLiveGattTeardownBarrier()
        val events = mutableListOf<String>()
        val first = barrier.beginTeardown()
        val second = barrier.beginTeardown()

        assertTrue(barrier.deferUntilIdle { events.add("connect") })
        barrier.completeTeardown(first)
        assertTrue(events.isEmpty())

        barrier.completeTeardown(second)
        assertEquals(listOf("connect"), events)
    }

    @Test
    fun `newest deferred connection replaces an older retry`() {
        val barrier = MentraLiveGattTeardownBarrier()
        val events = mutableListOf<String>()
        val teardown = barrier.beginTeardown()

        assertTrue(barrier.deferUntilIdle { events.add("stale reconnect") })
        assertTrue(barrier.deferUntilIdle { events.add("current user retry") })
        barrier.completeTeardown(teardown)

        assertEquals(listOf("current user retry"), events)
    }

    @Test
    fun `timeout releases connection and late disconnect cannot release it twice`() {
        val barrier = MentraLiveGattTeardownBarrier()
        var connections = 0
        val teardown = barrier.beginTeardown()

        barrier.deferUntilIdle { connections++ }
        barrier.completeTeardown(teardown)
        barrier.completeTeardown(teardown)

        assertEquals(1, connections)
        val connectImmediately: () -> Unit = { connections += 1 }
        assertFalse(barrier.deferUntilIdle(connectImmediately))
        connectImmediately()
        assertEquals(2, connections)
    }

    @Test
    fun `mtu callback and watchdog share one completion`() {
        val gate = MentraLiveMtuSetupGate()
        val setup = gate.begin()

        assertTrue(gate.complete(setup))
        assertFalse(gate.complete(setup))
    }

    @Test
    fun `cancelled mtu setup rejects a late callback`() {
        val gate = MentraLiveMtuSetupGate()
        val setup = gate.begin()

        gate.cancel()

        assertFalse(gate.complete(setup))
    }
}
