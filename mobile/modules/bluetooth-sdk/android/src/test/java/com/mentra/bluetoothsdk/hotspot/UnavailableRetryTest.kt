package com.mentra.bluetoothsdk.hotspot

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.Test

class UnavailableRetryTest {

    @Test
    fun `asks once more after an Unavailable`() {
        var requests = 0
        val result = ScopedSoftApNetwork.retryUnavailableOnce(
            request = { if (++requests == 1) throw ScopedNetworkError.Unavailable("glasses") else "joined" },
            settle = {},
            released = { false },
        )
        assertThat(result).isEqualTo("joined")
        assertThat(requests).isEqualTo(2)
    }

    @Test
    fun `a release during the settle stops the second request`() {
        var requests = 0
        var released = false
        assertThatThrownBy {
            ScopedSoftApNetwork.retryUnavailableOnce(
                request = { requests++; throw ScopedNetworkError.Unavailable("glasses") },
                settle = { released = true },
                released = { released },
            )
        }.isInstanceOf(ScopedNetworkError.Unavailable::class.java)
        assertThat(requests).isEqualTo(1)
    }

    @Test
    fun `a release before the settle skips it`() {
        var settled = false
        assertThatThrownBy {
            ScopedSoftApNetwork.retryUnavailableOnce<String>(
                request = { throw ScopedNetworkError.Unavailable("glasses") },
                settle = { settled = true },
                released = { true },
            )
        }.isInstanceOf(ScopedNetworkError.Unavailable::class.java)
        assertThat(settled).isFalse()
    }
}
