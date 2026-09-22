package com.mentra.glassesmedia.network

import com.mentra.glassesmedia.network.NetworkFacts.Iface
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

/**
 * The attribution helpers decide what the next SoftAP diagnosis says, so they are pinned rather
 * than eyeballed in a log line.
 */
class NetworkFactsTest {

    private fun iface(
        name: String,
        ipv4: List<String>,
        up: Boolean = true,
        loopback: Boolean = false,
    ) = Iface(name, 1, up, loopback, false, false, 1500, ipv4)

    private val table =
        listOf(
            iface("lo", listOf("127.0.0.1/8"), loopback = true),
            iface("wlan0", listOf("192.168.43.79/24")),
            iface("rmnet_data0", listOf("10.48.51.202/30")),
            iface("dummy0", emptyList()),
            iface("epdg0", listOf("10.9.9.9/32"), up = false),
        )

    @Test
    fun `the owner of an address is the interface the table says carries it`() {
        assertThat(NetworkFacts.ownerOf("192.168.43.79", table)).isEqualTo("wlan0")
        assertThat(NetworkFacts.ownerOf("10.48.51.202", table)).isEqualTo("rmnet_data0")
    }

    /** An address ICE gathered that is absent here means our two views of the network disagree. */
    @Test
    fun `an address the table has never seen has no owner`() {
        assertThat(NetworkFacts.ownerOf("192.168.50.7", table)).isNull()
    }

    @Test
    fun `a prefix is not mistaken for the address`() {
        assertThat(NetworkFacts.ownerOf("192.168.43.79/24", table)).isNull()
    }

    @Test
    fun `gatherable drops loopback, down, and addressless interfaces`() {
        assertThat(NetworkFacts.gatherable(table).map { it.name })
            .containsExactly("wlan0", "rmnet_data0")
    }

    @Test
    fun `render keeps the name, flags and every address`() {
        val line = NetworkFacts.render(listOf(iface("wlan0", listOf("192.168.43.79/24", "10.1.2.3/24"))))

        assertThat(line).contains("wlan0#1")
        assertThat(line).contains("192.168.43.79/24,10.1.2.3/24")
    }
}
