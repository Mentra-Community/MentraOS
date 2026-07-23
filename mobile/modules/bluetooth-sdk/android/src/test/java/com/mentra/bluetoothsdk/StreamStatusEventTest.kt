package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class StreamStatusEventTest {
    @Test
    fun `stream telemetry survives native status normalization`() {
        val event =
            StreamStatusEvent(
                mapOf(
                    "status" to "streaming",
                    "streamId" to "stream-1",
                    "stats" to
                        mapOf(
                            "bitrate" to 912_345L,
                            "fps" to 19.8,
                            "droppedFrames" to 2L,
                            "duration" to 31L,
                            "temperatureC" to 54.6,
                        ),
                )
            )

        assertThat(event.stats?.bitrate).isEqualTo(912_345L)
        assertThat(event.stats?.temperatureC).isEqualTo(54.6)
        assertThat((event.values["stats"] as Map<*, *>)["duration"]).isEqualTo(31L)
    }
}
