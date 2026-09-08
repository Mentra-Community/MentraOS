package com.mentra.acsmeeting.network

import com.mentra.acsmeeting.network.ScopedNetworkReadiness.Verdict
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

/**
 * The race these cases pin cost a misdiagnosis: ingest started on `onAvailable`, the hotspot address
 * was not yet in the kernel table, and the resulting candidate-less answer was blamed on socket
 * binding. Readiness now has to agree from three sources, and the missing one has to be named.
 */
class ScopedNetworkReadinessTest {

    private val readiness = ScopedNetworkReadiness()

    private fun joined() {
        readiness.onAvailable()
        readiness.onCapabilities()
        readiness.onLinkProperties("wlan0", "192.168.43.79")
    }

    @Test
    fun `a fresh gate waits for onAvailable`() {
        assertThat(readiness.verdict()).isEqualTo(Verdict.Waiting("onAvailable"))
        assertThat(readiness.callbacksSatisfied()).isFalse
    }

    /** Android's guidance, and the reason `onAvailable` alone was not enough. */
    @Test
    fun `onAvailable alone is not ready`() {
        readiness.onAvailable()

        assertThat(readiness.verdict()).isEqualTo(Verdict.Waiting("onCapabilitiesChanged"))
    }

    @Test
    fun `capabilities without an address is not ready`() {
        readiness.onAvailable()
        readiness.onCapabilities()

        assertThat(readiness.verdict()).isEqualTo(Verdict.Waiting("an IPv4 address from onLinkPropertiesChanged"))
    }

    /** The whole point: the callbacks can all agree while ICE still has nothing to gather. */
    @Test
    fun `every callback reporting is not ready until the kernel table has the address`() {
        joined()

        assertThat(readiness.callbacksSatisfied()).isTrue
        assertThat(readiness.verdict())
            .isEqualTo(Verdict.Waiting("the kernel interface table to carry 192.168.43.79"))
    }

    @Test
    fun `the address appearing in the table late completes readiness`() {
        joined()

        readiness.onInterfaceTable("wlan0")

        assertThat(readiness.verdict()).isEqualTo(Verdict.Ready("192.168.43.79", "wlan0", "wlan0"))
    }

    /**
     * A name disagreement is reported, not blocked on: ICE gathers per address, so the address being
     * in the table is what matters. Blocking here would fail calls that actually work.
     */
    @Test
    fun `the kernel owning the address under another name is still ready`() {
        joined()

        readiness.onInterfaceTable("wlan1")

        val verdict = readiness.verdict() as Verdict.Ready
        assertThat(verdict.interfaceName).isEqualTo("wlan0")
        assertThat(verdict.owner).isEqualTo("wlan1")
    }

    /** A later poll that no longer finds the address must un-ready the gate, not latch. */
    @Test
    fun `the address leaving the table takes readiness away again`() {
        joined()
        readiness.onInterfaceTable("wlan0")

        readiness.onInterfaceTable(null)

        assertThat(readiness.verdict()).isInstanceOf(Verdict.Waiting::class.java)
    }

    /** LinkProperties is a whole-state snapshot, so a later one without an address means gone. */
    @Test
    fun `a link properties update without an address clears the observation`() {
        joined()
        readiness.onInterfaceTable("wlan0")

        readiness.onLinkProperties("wlan0", null)

        assertThat(readiness.callbacksSatisfied()).isFalse
    }

    /** The synchronous read inside `onAvailable` is a hint; it must not erase a real callback. */
    @Test
    fun `seeding with no address does not clear what a callback reported`() {
        readiness.onLinkProperties("wlan0", "192.168.43.79")

        readiness.seedLinkProperties(null, null)

        assertThat(readiness.observations.linkAddress).isEqualTo("192.168.43.79")
    }

    @Test
    fun `seeding supplies the address when the callback has not arrived`() {
        readiness.onAvailable()
        readiness.seedLinkProperties("wlan0", "192.168.43.79")
        readiness.onCapabilities()

        assertThat(readiness.callbacksSatisfied()).isTrue
    }

    /** Rejoin reuses the instance, so a stale Ready from the previous call would be fatal. */
    @Test
    fun `reset returns the gate to waiting for onAvailable`() {
        joined()
        readiness.onInterfaceTable("wlan0")

        readiness.reset()

        assertThat(readiness.verdict()).isEqualTo(Verdict.Waiting("onAvailable"))
    }

    @Test
    fun `callbacks arriving out of order still resolve`() {
        readiness.onCapabilities()
        readiness.onLinkProperties("wlan0", "192.168.43.79")
        readiness.onInterfaceTable("wlan0")
        assertThat(readiness.verdict()).isEqualTo(Verdict.Waiting("onAvailable"))

        readiness.onAvailable()

        assertThat(readiness.verdict()).isInstanceOf(Verdict.Ready::class.java)
    }
}
