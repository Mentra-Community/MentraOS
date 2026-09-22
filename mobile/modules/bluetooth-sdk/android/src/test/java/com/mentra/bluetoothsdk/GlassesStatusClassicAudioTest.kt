package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class GlassesStatusClassicAudioTest {
    @Test
    fun `serializes connected Classic audio state for React Native`() {
        val serialized =
                GlassesStatus.fromMap(mapOf("bluetoothClassicConnected" to true)).toMap()

        assertThat(serialized["bluetoothClassicConnected"]).isEqualTo(true)
    }
}
