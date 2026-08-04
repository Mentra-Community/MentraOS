package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class BluetoothSdkExceptionTest {
    @Test
    fun `exception is usable without the Expo runtime`() {
        val cause = IllegalArgumentException("cause")
        val error = BluetoothSdkException("capture_failed", "Capture failed", cause)

        assertThat(error.code).isEqualTo("capture_failed")
        assertThat(error.message).isEqualTo("Capture failed")
        assertThat(error.cause).isSameAs(cause)
        assertThat(error).isInstanceOf(IllegalStateException::class.java)
        assertThat(error.javaClass.superclass.name).doesNotStartWith("expo.modules")
    }
}
