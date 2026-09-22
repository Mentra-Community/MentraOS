package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class StreamRequestTest {

    @Test
    fun `omission preserves default - telemetry not included in toMap`() {
        val request = StreamRequest(
            streamUrl = "https://example.com/whip",
            streamId = "s-1",
        )

        assertThat(request.telemetry).isNull()
        assertThat(request.toMap()).doesNotContainKey("telemetry")
        assertThat(request.toMap()).doesNotContainKey("tl")
    }

    @Test
    fun `fromMap preserves omission when telemetry key absent`() {
        val request = StreamRequest.fromMap(
            mapOf(
                "streamUrl" to "https://example.com/whip",
                "streamId" to "s-1",
            )
        )

        assertThat(request.telemetry).isNull()
        assertThat(request.toMap()).doesNotContainKey("telemetry")
    }

    @Test
    fun `forwards explicit true in toMap`() {
        val request = StreamRequest(
            streamUrl = "https://example.com/whip",
            streamId = "s-1",
            telemetry = true,
        )

        assertThat(request.telemetry).isTrue()
        assertThat(request.toMap()).containsEntry("telemetry", true)
    }

    @Test
    fun `fromMap forwards explicit true`() {
        val request = StreamRequest.fromMap(
            mapOf(
                "streamUrl" to "https://example.com/whip",
                "streamId" to "s-1",
                "telemetry" to true,
            )
        )

        assertThat(request.telemetry).isTrue()
        assertThat(request.toMap()).containsEntry("telemetry", true)
    }

    @Test
    fun `forwards explicit false in toMap`() {
        val request = StreamRequest(
            streamUrl = "https://example.com/whip",
            streamId = "s-1",
            telemetry = false,
        )

        assertThat(request.telemetry).isFalse()
        assertThat(request.toMap()).containsEntry("telemetry", false)
    }

    @Test
    fun `fromMap forwards explicit false`() {
        val request = StreamRequest.fromMap(
            mapOf(
                "streamUrl" to "https://example.com/whip",
                "streamId" to "s-1",
                "telemetry" to false,
            )
        )

        assertThat(request.telemetry).isFalse()
        assertThat(request.toMap()).containsEntry("telemetry", false)
    }

    @Test
    fun `fromMap accepts compact tl key when telemetry absent`() {
        val request = StreamRequest.fromMap(
            mapOf(
                "streamUrl" to "https://example.com/whip",
                "tl" to true,
            )
        )

        assertThat(request.telemetry).isTrue()
        assertThat(request.toMap()).containsEntry("telemetry", true)
    }

    @Test
    fun `fromMap gives full telemetry key precedence over compact tl`() {
        val request = StreamRequest.fromMap(
            mapOf(
                "streamUrl" to "https://example.com/whip",
                "telemetry" to false,
                "tl" to true,
            )
        )

        assertThat(request.telemetry).isFalse()
        assertThat(request.toMap()).containsEntry("telemetry", false)
    }

    @Test
    fun `full stream request serializes all fields`() {
        val request = StreamRequest(
            streamUrl = "https://example.com/whip",
            streamId = "stream-123",
            sound = false,
            video = StreamVideoConfig(width = 1280, height = 720, bitrate = 2_000_000, fps = 15),
            audio = StreamAudioConfig(bitrate = 64000, sampleRate = 48000, echoCancellation = true),
            authToken = "bearer-token",
            telemetry = true,
        )

        val map = request.toMap()
        assertThat(map["type"]).isEqualTo("start_stream")
        assertThat(map["streamUrl"]).isEqualTo("https://example.com/whip")
        assertThat(map["streamId"]).isEqualTo("stream-123")
        assertThat(map["sound"]).isEqualTo(false)
        assertThat(map["authToken"]).isEqualTo("bearer-token")
        assertThat(map["telemetry"]).isEqualTo(true)
        assertThat(map).containsKey("video")
        assertThat(map).containsKey("audio")
    }
}
