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

        barrier.runWhenIdle { events.add("connect") }
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

        barrier.runWhenIdle { events.add("connect") }
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

        barrier.runWhenIdle { events.add("stale reconnect") }
        barrier.runWhenIdle { events.add("current user retry") }
        barrier.completeTeardown(teardown)

        assertEquals(listOf("current user retry"), events)
    }

    @Test
    fun `timeout releases connection and late disconnect cannot release it twice`() {
        val barrier = MentraLiveGattTeardownBarrier()
        var connections = 0
        val teardown = barrier.beginTeardown()

        barrier.runWhenIdle { connections++ }
        barrier.completeTeardown(teardown)
        barrier.completeTeardown(teardown)

        assertEquals(1, connections)
        val connectImmediately: () -> Unit = { connections += 1 }
        barrier.runWhenIdle(connectImmediately)
        assertEquals(2, connections)
    }

    @Test
    fun `admitted connection runs inline before another teardown can begin`() {
        val barrier = MentraLiveGattTeardownBarrier()
        val events = mutableListOf<String>()
        barrier.runWhenIdle { events.add("connect") }
        barrier.beginTeardown()
        events.add("teardown")
        assertEquals(listOf("connect", "teardown"), events)
    }

    @Test
    fun `resumed connection can open another teardown without losing newer work`() {
        val barrier = MentraLiveGattTeardownBarrier()
        val first = barrier.beginTeardown()
        var next = 0L
        val events = mutableListOf<String>()
        barrier.runWhenIdle {
            next = barrier.beginTeardown()
            barrier.runWhenIdle { events.add("next") }
        }
        barrier.completeTeardown(first)
        assertTrue(events.isEmpty())
        barrier.completeTeardown(next)
        assertEquals(listOf("next"), events)
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
