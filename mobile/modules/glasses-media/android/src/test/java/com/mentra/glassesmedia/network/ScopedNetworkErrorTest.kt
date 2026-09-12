package com.mentra.glassesmedia.network

import com.mentra.glassesmedia.network.ScopedNetworkState.Failure
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class ScopedNetworkErrorTest {

    @Test
    fun `no failure maps to no error`() {
        assertThat(ScopedNetworkError.from(Failure.NONE, "ssid", 30_000)).isNull()
    }

    @Test
    fun `each failure maps to its typed error and stable code`() {
        assertThat(ScopedNetworkError.from(Failure.TIMEOUT, "ap", 30_000))
            .isInstanceOf(ScopedNetworkError.Timeout::class.java)
            .extracting("code")
            .isEqualTo(ScopedNetworkError.CODE_TIMEOUT)

        assertThat(ScopedNetworkError.from(Failure.UNAVAILABLE, "ap", 30_000))
            .isInstanceOf(ScopedNetworkError.Unavailable::class.java)

        assertThat(ScopedNetworkError.from(Failure.LOST, "ap", 30_000))
            .isInstanceOf(ScopedNetworkError.Lost::class.java)

        assertThat(ScopedNetworkError.from(Failure.REQUEST_FAILED, "ap", 30_000))
            .isInstanceOf(ScopedNetworkError.RequestFailed::class.java)
    }

    /**
     * A denied permission must be its own error, not a timeout: otherwise it looks like a flaky
     * hotspot and costs 30 seconds before failing.
     */
    @Test
    fun `permission denial is distinct from a timeout`() {
        val denied = ScopedNetworkError.from(Failure.PERMISSION_DENIED, "ap", 30_000)

        assertThat(denied).isInstanceOf(ScopedNetworkError.PermissionDenied::class.java)
        assertThat(denied?.code).isEqualTo(ScopedNetworkError.CODE_PERMISSION_DENIED)
        assertThat(denied?.code).isNotEqualTo(ScopedNetworkError.CODE_TIMEOUT)
    }

    @Test
    fun `error codes are stable and unique`() {
        val codes =
            listOf(
                ScopedNetworkError.CODE_PERMISSION_DENIED,
                ScopedNetworkError.CODE_TIMEOUT,
                ScopedNetworkError.CODE_UNAVAILABLE,
                ScopedNetworkError.CODE_LOST,
                ScopedNetworkError.CODE_REQUEST_FAILED,
                ScopedNetworkError.CODE_NO_LOCAL_ADDRESS,
                ScopedNetworkError.CODE_NOT_READY,
                ScopedNetworkError.CODE_WIFI_DISABLED,
                ScopedNetworkError.CODE_VPN_ACTIVE,
            )

        assertThat(codes).doesNotHaveDuplicates()
        assertThat(codes).allMatch { it.startsWith("SOFTAP_") }
    }

    @Test
    fun `messages name the ssid so a log line is actionable`() {
        assertThat(ScopedNetworkError.Timeout("MentraLive-1234", 30_000).message)
            .contains("MentraLive-1234")
            .contains("30000")
        assertThat(ScopedNetworkError.Lost("MentraLive-1234").message).contains("MentraLive-1234")
    }

    @Test
    fun `a capturing vpn is named as the cause and tells the user what to change`() {
        val error = ScopedNetworkError.VpnCapturesApp()
        assertThat(error.code).isEqualTo(ScopedNetworkError.CODE_VPN_ACTIVE)
        assertThat(error.message).contains("VPN").contains("split tunneling")
    }

    /**
     * "Joined but not usable" has to be its own code. Reported as a join success it becomes an ICE
     * answer with no candidates, which is the symptom several unrelated faults share.
     */
    @Test
    fun `a network that joined but never became usable names the missing source`() {
        val error = ScopedNetworkError.NotReady("MentraLive-1234", "the kernel interface table")

        assertThat(error.code).isEqualTo(ScopedNetworkError.CODE_NOT_READY)
        assertThat(error.code).isNotEqualTo(ScopedNetworkError.CODE_NO_LOCAL_ADDRESS)
        assertThat(error.message).contains("MentraLive-1234").contains("the kernel interface table")
    }

    @Test
    fun `the local network permission name is the platform constant`() {
        assertThat(ScopedNetworkError.LOCAL_NETWORK_PERMISSION)
            .isEqualTo("android.permission.ACCESS_LOCAL_NETWORK")
    }
}
