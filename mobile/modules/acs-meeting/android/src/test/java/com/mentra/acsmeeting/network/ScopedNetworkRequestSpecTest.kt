package com.mentra.acsmeeting.network

import android.net.NetworkCapabilities
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

/**
 * Guards the one property the whole dual-homing design rests on: the SoftAP request must not ask
 * for `NET_CAPABILITY_INTERNET`. If that regresses, Android can promote the glasses hotspot to the
 * default network and ACS traffic silently stops using cellular.
 */
class ScopedNetworkRequestSpecTest {

    @Test
    fun `the softap request removes the internet capability`() {
        val spec = ScopedNetworkRequestSpec.forSoftAp("MentraLive-1234", "hunter2")

        assertThat(spec.removedCapabilities).contains(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        assertThat(spec.avoidsInternetCapability).isTrue()
    }

    @Test
    fun `the softap request is wifi only`() {
        val spec = ScopedNetworkRequestSpec.forSoftAp("MentraLive-1234", "hunter2")

        assertThat(spec.transportTypes).containsExactly(NetworkCapabilities.TRANSPORT_WIFI)
    }

    @Test
    fun `ssid and passphrase are carried through`() {
        val spec = ScopedNetworkRequestSpec.forSoftAp("MentraLive-1234", "hunter2")

        assertThat(spec.ssid).isEqualTo("MentraLive-1234")
        assertThat(spec.passphrase).isEqualTo("hunter2")
        assertThat(spec.hasPassphrase).isTrue()
    }

    @Test
    fun `an open network reports no passphrase`() {
        assertThat(ScopedNetworkRequestSpec.forSoftAp("Open-AP", "").hasPassphrase).isFalse()
    }

    @Test
    fun `the default timeout matches the bluetooth sdk hotspot join`() {
        assertThat(ScopedNetworkRequestSpec.forSoftAp("x", "y").timeoutMs).isEqualTo(30_000)
        assertThat(ScopedNetworkRequestSpec.DEFAULT_TIMEOUT_MS).isEqualTo(30_000)
    }

    @Test
    fun `the timeout is overridable`() {
        assertThat(ScopedNetworkRequestSpec.forSoftAp("x", "y", timeoutMs = 5_000).timeoutMs)
            .isEqualTo(5_000)
    }

    /** A spec that kept the internet capability must not read as safe. */
    @Test
    fun `avoidsInternetCapability is false when the capability is not removed`() {
        val unsafe =
            ScopedNetworkRequestSpec(
                ssid = "x",
                passphrase = "y",
                transportTypes = setOf(NetworkCapabilities.TRANSPORT_WIFI),
                removedCapabilities = emptySet(),
                timeoutMs = 1_000,
            )

        assertThat(unsafe.avoidsInternetCapability).isFalse()
    }
}
