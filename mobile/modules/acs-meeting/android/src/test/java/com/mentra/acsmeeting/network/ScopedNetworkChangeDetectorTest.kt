package com.mentra.acsmeeting.network

import com.mentra.acsmeeting.network.ScopedNetworkChangeDetector.Companion.formatIpv4
import com.mentra.acsmeeting.network.ScopedNetworkChangeDetector.Companion.mergeScopedNetwork
import com.mentra.acsmeeting.network.ScopedNetworkChangeDetector.Companion.renderInventory
import com.mentra.acsmeeting.network.ScopedNetworkChangeDetector.Companion.toNetworkInformation
import com.mentra.acsmeeting.network.ScopedNetworkChangeDetector.ScopedInterface
import com.mentra.acsmeeting.source.SoftApIcePolicy
import org.webrtc.PeerConnectionFactory
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
    fun `the scoped SoftAP is the only Wi-Fi in the inventory`() {
        val merged = mergeScopedNetwork(listOf(detected("rmnet0")), softAp())

        assertThat(merged.map { it.name }).containsExactly("wlan1")
        assertThat(merged.single().ipAddresses[0].address).isEqualTo(ipv4(192, 168, 43, 20))
    }

    /**
     * The collision that produced `count=0` candidates on device when two entries shared handle 0.
     * One entry with the real handle cannot collide with itself.
     */
    @Test
    fun `the inventory is a single entry, so no two entries can share a handle`() {
        val merged = mergeScopedNetwork(listOf(detected("rmnet_data0"), detected("wlan0")), softAp())

        assertThat(merged).hasSize(1)
        assertThat(merged.map { it.handle }.distinct()).hasSize(1)
    }

    /** The mask has to leave the hotspot gatherable, and nothing else is offered to it. */
    @Test
    fun `the published hotspot survives the ignore mask`() {
        val merged = mergeScopedNetwork(emptyList(), softAp())
        val mask = SoftApIcePolicy.networkIgnoreMask()

        val gatherable = merged.filter { SoftApIcePolicy.allowsAdapter(mask, adapterTypeOf(it.type)) }

        assertThat(gatherable.map { it.name }).containsExactly("wlan1")
    }

    /** Mirrors libwebrtc's `AdapterTypeFromNetworkType` for the two types this merge produces. */
    private fun adapterTypeOf(type: NetworkChangeDetector.ConnectionType): Int =
        when (type) {
            NetworkChangeDetector.ConnectionType.CONNECTION_WIFI ->
                PeerConnectionFactory.Options.ADAPTER_TYPE_WIFI
            NetworkChangeDetector.ConnectionType.CONNECTION_4G ->
                PeerConnectionFactory.Options.ADAPTER_TYPE_CELLULAR
            else -> PeerConnectionFactory.Options.ADAPTER_TYPE_UNKNOWN
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

    @Test
    fun `a same-named stock wlan0 is replaced by the scoped SoftAP address`() {
        // This phone: stock detector reports wlan0 at 10.15.68.161 (internet Wi-Fi). SoftAP is a
        // different Network that reuses the name wlan0 at 192.168.43.79. Matching on name and
        // keeping the stock entry is how ICE answered with the 10.x host candidate.
        val stockWifi = detected("wlan0")
        val scoped = softAp(name = "wlan0", handle = 99L)

        val merged = mergeScopedNetwork(listOf(stockWifi), scoped)

        assertThat(merged).hasSize(1)
        assertThat(merged.single().ipAddresses[0].address).isEqualTo(ipv4(192, 168, 43, 20))
    }

    /**
     * Handle 0 advertised the right address and then never completed an ICE check (18:56 / 19:01).
     * The real handle is what marks the socket onto the SoftAP; the SDP pin puts the scoped IP
     * back in the answer the glasses see.
     */
    @Test
    fun `the hotspot is published with its real network handle`() {
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
    fun `formatIpv4 renders a dotted-quad`() {
        assertThat(formatIpv4(ipv4(10, 15, 68, 161))).isEqualTo("10.15.68.161")
    }

    @Test
    fun `multiple addresses are all published`() {
        val multi =
            ScopedInterface("wlan1", 42L, listOf(ipv4(192, 168, 43, 20), ipv4(192, 168, 43, 21)))

        assertThat(toNetworkInformation(multi)!!.ipAddresses).hasSize(2)
    }

    /** The rejection diagnostics read this, so a handle collision has to be visible in it. */
    @Test
    fun `renderInventory names every entry with its type, handle and addresses`() {
        val rendered = renderInventory(mergeScopedNetwork(emptyList(), softAp()))

        assertThat(rendered).isEqualTo("wlan1[CONNECTION_WIFI]#42(192.168.43.20)")
    }

    @Test
    fun `renderInventory tolerates a null list`() {
        assertThat(renderInventory(null)).isEmpty()
    }
}
