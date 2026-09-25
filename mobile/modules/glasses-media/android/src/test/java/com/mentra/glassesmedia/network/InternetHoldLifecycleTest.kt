package com.mentra.glassesmedia.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Test
import org.mockito.ArgumentMatchers.*
import org.mockito.Mockito.*

/** Real request/close lifecycle with the Android service mocked; no radio or network required. */
class InternetHoldLifecycleTest {
    private class Fixture {
        val context = mock(Context::class.java)
        val manager = mock(ConnectivityManager::class.java)
        val network = mock(Network::class.java)
        val capabilities = mock(NetworkCapabilities::class.java)
        val requested = CountDownLatch(1)
        lateinit var callback: ConnectivityManager.NetworkCallback
        val hold: InternetHold

        init {
            `when`(context.applicationContext).thenReturn(context)
            `when`(context.getSystemService(ConnectivityManager::class.java)).thenReturn(manager)
            `when`(manager.allNetworks).thenReturn(arrayOf(network))
            `when`(manager.getNetworkCapabilities(network)).thenReturn(capabilities)
            `when`(capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)).thenReturn(true)
            `when`(capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)).thenReturn(true)
            `when`(capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)).thenReturn(true)
            `when`(manager.bindProcessToNetwork(network)).thenReturn(true)
            doAnswer {
                callback = it.getArgument(1)
                requested.countDown()
                null
            }.`when`(manager).requestNetwork(nullable(NetworkRequest::class.java), any(ConnectivityManager.NetworkCallback::class.java))
            hold = InternetHold(context)
        }

        // The plain JVM android.jar has no implementation of Builder's fluent methods.
        // Scope this stub to the caller thread, including the validation-wait worker test.
        fun awaitCellular(timeoutMs: Long): InternetHold.CellularHold =
            mockConstruction(NetworkRequest.Builder::class.java, withSettings().defaultAnswer(RETURNS_SELF)) { builder, _ ->
                `when`(builder.build()).thenReturn(mock(NetworkRequest::class.java))
            }.use { hold.awaitValidatedCellular(timeoutMs) }
    }

    @Test
    fun `publisher selection skips validated IMS and DUN networks before internet`() {
        val f = Fixture()
        val ims = mock(Network::class.java)
        val dun = mock(Network::class.java)
        for (network in listOf(ims, dun)) {
            val caps = mock(NetworkCapabilities::class.java)
            `when`(caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)).thenReturn(true)
            `when`(caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)).thenReturn(true)
            `when`(f.manager.getNetworkCapabilities(network)).thenReturn(caps)
        }
        `when`(f.manager.allNetworks).thenReturn(arrayOf(ims, dun, f.network))
        assertSame(f.network, InternetHold.findValidatedCellular(f.manager))
        assertTrue(f.hold.bindProcessToCellular())
        verify(f.manager).bindProcessToNetwork(f.network)
        `when`(f.manager.allNetworks).thenReturn(arrayOf(ims, dun))
        assertNull(InternetHold.findValidatedCellular(f.manager))
        assertFalse(f.hold.bindProcessToCellular())
    }

    @Test
    fun `publisher selection rejects unvalidated cellular and validated wifi`() {
        val f = Fixture()
        `when`(f.capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)).thenReturn(false)
        assertNull(InternetHold.findValidatedCellular(f.manager))
        `when`(f.capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)).thenReturn(true)
        `when`(f.capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)).thenReturn(false)
        assertNull(InternetHold.findValidatedCellular(f.manager))
    }

    @Test
    fun `destroy with no default network drops pin and invalidates old callbacks`() {
        val f = Fixture()
        assertTrue(f.awaitCellular(0).validated)
        assertFalse(f.hold.defaultNetwork().usable)
        clearInvocations(f.manager)
        f.hold.close()
        verify(f.manager).unregisterNetworkCallback(f.callback)
        verify(f.manager).bindProcessToNetwork(null)
        clearInvocations(f.manager)
        f.callback.onCapabilitiesChanged(mock(Network::class.java), f.capabilities)
        f.callback.onLost(f.network)
        f.hold.close()
        assertFalse(f.hold.bindProcessToCellular())
        assertFalse(f.awaitCellular(0).held)
        verify(f.manager, never()).bindProcessToNetwork(nullable(Network::class.java))
        verify(f.manager, never()).requestNetwork(nullable(NetworkRequest::class.java), any(ConnectivityManager.NetworkCallback::class.java))
    }

    @Test
    fun `late validation cannot resurrect a hold destroyed during its wait`() {
        val f = Fixture()
        val result = AtomicReference<InternetHold.CellularHold>()
        val worker = Thread { result.set(f.awaitCellular(2_000)) }
        worker.start()
        try {
            assertTrue(f.requested.await(1, TimeUnit.SECONDS))
            f.hold.close()
            clearInvocations(f.manager)
            f.callback.onCapabilitiesChanged(f.network, f.capabilities)
            worker.join(1_000)
            assertFalse(worker.isAlive)
            assertFalse(result.get().held)
            assertFalse(result.get().validated)
            verify(f.manager, never()).bindProcessToNetwork(nullable(Network::class.java))
        } finally {
            worker.interrupt()
            worker.join(2_000)
        }
    }

    @Test
    fun `ordinary release still permits reuse while close is permanent`() {
        val f = Fixture()
        assertTrue(f.awaitCellular(0).held)
        f.hold.release()
        assertTrue(f.awaitCellular(0).validated)
        f.hold.close()
        assertFalse(f.awaitCellular(0).held)
    }

    @Test
    fun `unvalidated cellular still holds the request`() {
        val f = Fixture()
        `when`(f.capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)).thenReturn(false)
        val result = f.awaitCellular(0)
        assertTrue(result.held)
        assertFalse(result.validated)
    }

    @Test
    fun `listener binds without cellular and restores the pin afterwards`() {
        val f = Fixture()
        assertTrue(f.awaitCellular(0).validated)
        clearInvocations(f.manager)

        val result = f.hold.withProcessUnpinned {
            verify(f.manager).bindProcessToNetwork(null)
            verify(f.manager, never()).bindProcessToNetwork(f.network)
            "listener"
        }

        assertEquals("listener", result)
        inOrder(f.manager).apply {
            verify(f.manager).bindProcessToNetwork(null)
            verify(f.manager).bindProcessToNetwork(f.network)
        }
        f.hold.close()
    }

    @Test
    fun `failed listener bind still restores cellular`() {
        val f = Fixture()
        assertTrue(f.awaitCellular(0).validated)
        clearInvocations(f.manager)
        val failure = IllegalStateException("bind failed")

        val thrown = assertThrows(IllegalStateException::class.java) {
            f.hold.withProcessUnpinned {
                verify(f.manager).bindProcessToNetwork(null)
                throw failure
            }
        }

        assertSame(failure, thrown)
        verify(f.manager).bindProcessToNetwork(f.network)
        f.hold.close()
    }

    @Test
    fun `listener without a cellular pin leaves routing unchanged`() {
        val f = Fixture()
        assertEquals("listener", f.hold.withProcessUnpinned { "listener" })
        verify(f.manager, never()).bindProcessToNetwork(nullable(Network::class.java))
        f.hold.close()
    }
}
