package com.mentra.acsmeeting.network

import com.mentra.acsmeeting.network.ScopedNetworkChangeDetector.Companion.mergeScopedNetwork
import com.mentra.acsmeeting.network.ScopedNetworkChangeDetector.Companion.toNetworkInformation
import com.mentra.acsmeeting.network.ScopedNetworkChangeDetector.ScopedInterface
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test
import org.webrtc.NetworkChangeDetector

/**
 * The merge is the part that decides whether ICE can see the hotspot at all, so it is tested
 * directly rather than only through the on-device gate.
 */
class ScopedNetworkChangeDetectorTest {

    private fun ipv4(a: Int, b: Int, c: Int, d: Int) =
        byteArrayOf(a.toByte(), b.toByte(), c.toByte(), d.toByte())

    private fun softAp(name: String = "wlan1", handle: Long = 42L) =
        ScopedInterface(name, handle, listOf(ipv4(192, 168, 43, 20)))

    private fun detected(name: String) =
        NetworkChangeDetector.NetworkInformation(
            name,
            NetworkChangeDetector.ConnectionType.CONNECTION_4G,
            NetworkChangeDetector.ConnectionType.CONNECTION_NONE,
            7L,
            arrayOf(NetworkChangeDetector.IPAddress(ipv4(10, 8, 0, 2))),
        )

    @Test
    fun `the scoped interface is appended to the inventory`() {
        val merged = mergeScopedNetwork(listOf(detected("rmnet0")), softAp())

        assertThat(merged).hasSize(2)
        assertThat(merged.map { it.name }).containsExactly("rmnet0", "wlan1")
    }

    /** Without this, ICE never gathers a candidate on the hotspot subnet. */
    @Test
    fun `the scoped interface appears even when the delegate reports nothing`() {
        val merged = mergeScopedNetwork(emptyList(), softAp())

        assertThat(merged.map { it.name }).containsExactly("wlan1")
    }

    @Test
    fun `a null delegate list is tolerated`() {
        assertThat(mergeScopedNetwork(null, softAp())).hasSize(1)
    }

    @Test
    fun `no scoped network leaves the inventory untouched`() {
        val detectedList = listOf(detected("rmnet0"))

        assertThat(mergeScopedNetwork(detectedList, null).map { it.name }).containsExactly("rmnet0")
    }

    /** Publishing it twice would give libwebrtc duplicate candidates for one interface. */
    @Test
    fun `the scoped interface is not duplicated when the delegate already saw it`() {
        val merged = mergeScopedNetwork(listOf(detected("wlan1")), softAp(name = "wlan1"))

        assertThat(merged).hasSize(1)
        assertThat(merged.single().handle).isEqualTo(7L)
    }

    @Test
    fun `the cellular default is preserved alongside the scoped network`() {
        val merged = mergeScopedNetwork(listOf(detected("rmnet0")), softAp())

        val cellular = merged.single { it.name == "rmnet0" }
        assertThat(cellular.type).isEqualTo(NetworkChangeDetector.ConnectionType.CONNECTION_4G)
    }

    @Test
    fun `the published network carries the real network handle`() {
        val information = toNetworkInformation(softAp(handle = 99L))

        assertThat(information).isNotNull
        assertThat(information!!.handle).isEqualTo(99L)
        assertThat(information.type).isEqualTo(NetworkChangeDetector.ConnectionType.CONNECTION_WIFI)
    }

    @Test
    fun `the published network carries the hotspot address`() {
        val information = toNetworkInformation(softAp())!!

        assertThat(information.ipAddresses).hasSize(1)
        assertThat(information.ipAddresses[0].address).isEqualTo(ipv4(192, 168, 43, 20))
    }

    @Test
    fun `an interface with no address is not published`() {
        val addressless = ScopedInterface("wlan1", 42L, emptyList())

        assertThat(toNetworkInformation(addressless)).isNull()
        assertThat(mergeScopedNetwork(emptyList(), addressless)).isEmpty()
    }

    @Test
    fun `multiple addresses are all published`() {
        val multi =
            ScopedInterface("wlan1", 42L, listOf(ipv4(192, 168, 43, 20), ipv4(192, 168, 43, 21)))

        assertThat(toNetworkInformation(multi)!!.ipAddresses).hasSize(2)
    }
}
