package com.mentra.glassesmedia.network

import com.mentra.glassesmedia.network.ScopedNetworkChangeDetector.ScopedInterface
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import org.webrtc.NetworkChangeDetector

/**
 * The takeover keeps a process-wide monitor from answering SoftAP with a leftover cellular handle;
 * the restore keeps that takeover from breaking the next WHEP or LiveKit connection in the same
 * process. Both halves are tested against a recording observer rather than the on-device gate.
 */
class ScopedNetworkObserverTest {

    private val connected = mutableListOf<Long>()
    private val disconnected = mutableListOf<Long>()
    private var scoped: ScopedInterface? = softAp()

    private val downstream =
        object : NetworkChangeDetector.Observer() {
            override fun onConnectionTypeChanged(connectionType: NetworkChangeDetector.ConnectionType) = Unit

            override fun onNetworkConnect(networkInfo: NetworkChangeDetector.NetworkInformation) {
                connected.add(networkInfo.handle)
            }

            override fun onNetworkDisconnect(networkHandle: Long) {
                disconnected.add(networkHandle)
            }

            override fun onNetworkPreference(
                types: MutableList<NetworkChangeDetector.ConnectionType>,
                preference: Int,
            ) = Unit
        }

    private val observer = ScopedNetworkObserver(downstream, { scoped })

    @Test
    fun `relay mode keeps cellular connects and disconnects visible beside the hotspot`() {
        val relay = ScopedNetworkObserver(downstream, { scoped }, { true })
        relay.onNetworkConnect(info("rmnet_data0", 7L))
        assertThat(connected).contains(7L, 99L)
        assertThat(disconnected).doesNotContain(7L)
        connected.clear()
        relay.onNetworkDisconnect(7L)
        assertThat(disconnected).contains(7L)
        assertThat(connected).containsExactly(99L)
    }

    @Test
    fun `relay inventory replaces stale wifi on the same interface without hiding internet`() {
        val merged = ScopedNetworkChangeDetector.mergeScopedNetwork(
            listOf(info("wlan0", 8L), info("rmnet_data0", 7L)), scoped, true)
        assertThat(merged.map { it.handle }).containsExactly(7L, 99L)
    }

    private fun ipv4(a: Int, b: Int, c: Int, d: Int) =
        byteArrayOf(a.toByte(), b.toByte(), c.toByte(), d.toByte())

    private fun softAp() = ScopedInterface("wlan0", 99L, listOf(ipv4(192, 168, 43, 79)))

    private fun hotspot() = ScopedNetworkChangeDetector.toNetworkInformation(softAp())!!

    private fun info(name: String, handle: Long, address: ByteArray = ipv4(10, 1, 2, 3)) =
        NetworkChangeDetector.NetworkInformation(
            name,
            NetworkChangeDetector.ConnectionType.CONNECTION_4G,
            NetworkChangeDetector.ConnectionType.CONNECTION_NONE,
            handle,
            arrayOf(NetworkChangeDetector.IPAddress(address)),
        )

    @Test
    fun `a stock connect is swallowed while SoftAP is joined`() {
        observer.onNetworkConnect(info("rmnet_data0", 7L))

        assertThat(connected).isEmpty()
    }

    /**
     * The monitor is already running when a SoftAP call starts: ACS joins over cellular first, so
     * those handles are in the native list before ingest exists. They have to be dropped.
     */
    @Test
    fun `publish drops networks announced before the join and connects only the inventory`() {
        observer.onNetworkConnect(info("rmnet_data0", 7L))
        observer.onNetworkConnect(info("wlan0", 8L, ipv4(192, 168, 50, 7)))

        observer.publish(listOf(hotspot()))

        assertThat(disconnected).containsExactly(7L, 8L)
        assertThat(connected).containsExactly(99L)
    }

    @Test
    fun `a second publish of the same inventory is a no-op`() {
        observer.publish(listOf(hotspot()))
        connected.clear()

        observer.publish(listOf(hotspot()))

        assertThat(connected).isEmpty()
        assertThat(disconnected).isEmpty()
    }

    /**
     * Teardown followed by ordinary WebRTC. Resuming pass-through alone would leave these networks
     * missing until the OS happened to re-announce them, and leave the synthetic entry in place.
     */
    @Test
    fun `teardown drops the synthetic entry and replays the suppressed networks`() {
        observer.onNetworkConnect(info("rmnet_data0", 7L))
        observer.publish(listOf(hotspot()))
        connected.clear()
        disconnected.clear()

        scoped = null
        observer.restore()

        assertThat(disconnected).containsExactly(99L)
        assertThat(connected).containsExactly(7L)
    }

    /** A network that genuinely went away while SoftAP was up must not come back in the replay. */
    @Test
    fun `a network lost during the call is not replayed on teardown`() {
        observer.onNetworkConnect(info("rmnet_data0", 7L))
        observer.onNetworkConnect(info("wlan0", 8L, ipv4(192, 168, 50, 7)))
        observer.publish(listOf(hotspot()))
        observer.onNetworkDisconnect(8L)
        connected.clear()

        scoped = null
        observer.restore()

        assertThat(connected).containsExactly(7L)
    }

    @Test
    fun `restore is idempotent and a no-op when ownership was never taken`() {
        scoped = null

        observer.restore()
        observer.restore()

        assertThat(connected).isEmpty()
        assertThat(disconnected).isEmpty()
    }

    /** Restoration is also driven from the OS side, since after teardown it may be the only caller. */
    @Test
    fun `a stock callback after teardown restores before forwarding, and forwards once`() {
        observer.onNetworkConnect(info("rmnet_data0", 7L))
        observer.publish(listOf(hotspot()))
        connected.clear()
        disconnected.clear()

        scoped = null
        observer.onNetworkConnect(info("wlan0", 8L, ipv4(192, 168, 50, 7)))

        assertThat(disconnected).containsExactly(99L)
        assertThat(connected).containsExactly(7L, 8L)
    }

    @Test
    fun `stock callbacks pass through once the hotspot is gone`() {
        scoped = null

        observer.onNetworkConnect(info("rmnet_data0", 7L))

        assertThat(connected).containsExactly(7L)
    }

    /** Rejoin is part of the acceptance bar, so the takeover has to re-arm after a restore. */
    @Test
    fun `an immediate rejoin takes the monitor back over`() {
        observer.onNetworkConnect(info("rmnet_data0", 7L))
        observer.publish(listOf(hotspot()))
        scoped = null
        observer.restore()
        connected.clear()
        disconnected.clear()

        scoped = softAp()
        observer.publish(listOf(hotspot()))

        assertThat(disconnected).containsExactly(7L)
        assertThat(connected).containsExactly(99L)
    }
}
