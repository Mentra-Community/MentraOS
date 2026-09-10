package com.mentra.bluetoothsdk

import com.mentra.bluetoothsdk.sgcs.G2SerialResolution
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class G2SerialResolutionTest {
    @Test
    fun `a scanned serial always wins`() {
        assertThat(G2SerialResolution.resolve("S2ABCD12345678", "OTHER", "S2OLD000000000")).isEqualTo("S2ABCD12345678")
    }

    @Test
    fun `a cached reconnect reuses the persisted serial only when it is the requested id`() {
        assertThat(G2SerialResolution.resolve(null, "S2ABCD12345678", "S2ABCD12345678")).isEqualTo("S2ABCD12345678")
        assertThat(G2SerialResolution.resolve(null, "12345678", "S2ABCD12345678")).isNull()
        assertThat(G2SerialResolution.resolve(null, "S2ABCD12345678", "")).isNull()
        assertThat(G2SerialResolution.resolve(null, "NOT_SET", "NOT_SET")).isNull()
    }

    @Test
    fun `switching to a different pair does not leak the previous serial`() {
        assertThat(G2SerialResolution.resolve(null, "S2NEW000000001", "S2OLD000000000")).isNull()
    }
}
