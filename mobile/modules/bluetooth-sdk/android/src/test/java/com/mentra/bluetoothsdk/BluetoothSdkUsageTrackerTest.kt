package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class BluetoothSdkUsageTrackerTest {
    private val tracker = BluetoothSdkUsageTracker()

    @Test
    fun `an API photo reports its request shape, latency and outcome`() {
        val ok = tracker.photoSettled("medium", "photo", "none", save = true, transferMethod = "auto", latencyMs = 812, fileSizeBytes = 204_800, errorCode = null)
        assertThat(ok.name).isEqualTo("bluetooth_sdk_photo_taken")
        assertThat(ok.properties)
            .containsEntry("trigger", "api")
            .containsEntry("success", true)
            .containsEntry("latency_ms", 812L)
            .containsEntry("photo_size", "medium")
            .containsEntry("save_to_gallery", true)
            .containsEntry("transfer_method", "auto")
            .containsEntry("file_size_bytes", 204_800L)
            .doesNotContainKey("error_code")

        val failed = tracker.photoSettled("max", "photo", "none", save = false, transferMethod = "ble", latencyMs = 30_000, fileSizeBytes = null, errorCode = "request_timeout")
        assertThat(failed.properties)
            .containsEntry("success", false)
            .containsEntry("error_code", "request_timeout")
            .doesNotContainKey("file_size_bytes")
    }

    @Test
    fun `a failed button photo is reported as a button trigger`() {
        val event = tracker.buttonPhotoFailed("CAMERA_BUSY")
        assertThat(event.properties).containsEntry("trigger", "button").containsEntry("success", false).containsEntry("error_code", "CAMERA_BUSY")
    }

    @Test
    fun `an API recording reports its length, parameters and app stop once`() {
        tracker.videoRequested("rec-1", width = 1920, height = 1080, fps = 30, save = true, maxDurationMinutes = 0)
        assertThat(tracker.videoStatus("rec-1", "recording_started", success = true, nowMs = 1_000)).isNull()
        // A duplicate start does not move the start time.
        assertThat(tracker.videoStatus("rec-1", "recording_started", success = true, nowMs = 2_000)).isNull()
        tracker.videoStopRequested("rec-1")

        val stopped = tracker.videoStatus("rec-1", "recording_stopped", success = true, nowMs = 61_000)!!
        assertThat(stopped.name).isEqualTo("bluetooth_sdk_video_recorded")
        assertThat(stopped.properties)
            .containsEntry("trigger", "api")
            .containsEntry("success", true)
            .containsEntry("duration_ms", 60_000L)
            .containsEntry("width", 1920)
            .containsEntry("fps", 30)
            .containsEntry("save_to_gallery", true)
            .containsEntry("stopped_by_app", true)
            .doesNotContainKey("max_duration_minutes")

        assertThat(tracker.videoStatus("rec-1", "recording_stopped", success = true, nowMs = 62_000)).isNull()
    }

    @Test
    fun `a button recording is reported with a button trigger and no app stop`() {
        val id = "local_video_1728000000_ab12"
        tracker.videoStatus(id, "recording_started", success = true, nowMs = 0)
        val stopped = tracker.videoStatus(id, "recording_stopped", success = true, nowMs = 5_000)!!
        assertThat(stopped.properties)
            .containsEntry("trigger", "button")
            .containsEntry("duration_ms", 5_000L)
            .containsEntry("stopped_by_app", false)
    }

    @Test
    fun `a recording failure is reported, but not_recording is not a recording`() {
        tracker.videoRequested("rec-2", 0, 0, 0, save = false, maxDurationMinutes = 5)
        val failed = tracker.videoStatus("rec-2", "battery_low", success = false, nowMs = 0)!!
        assertThat(failed.properties)
            .containsEntry("success", false)
            .containsEntry("error_code", "battery_low")
            .containsEntry("max_duration_minutes", 5)
            .doesNotContainKey("duration_ms")
            .doesNotContainKey("width")

        assertThat(tracker.videoStatus("rec-3", "not_recording", success = false, nowMs = 0)).isNull()
        assertThat(tracker.videoStatus("", "recording_stopped", success = true, nowMs = 0)).isNull()
    }

    @Test
    fun `a stream is reported at start and once at its terminal status`() {
        val started =
            tracker.streamStartSettled(
                streamId = "s1",
                streamUrl = "rtmps://live.example.com/app/secret-key",
                width = 1280,
                height = 720,
                fps = 30,
                bitrate = 2_000_000,
                captureAudio = true,
                glassesNetwork = "wifi",
                latencyMs = 3_400,
                errorCode = null,
                nowMs = 10_000,
            )
        assertThat(started.name).isEqualTo("bluetooth_sdk_stream_started")
        assertThat(started.properties)
            .containsEntry("success", true)
            .containsEntry("protocol", "rtmp")
            .containsEntry("glasses_network", "wifi")
        assertThat(started.properties.values.map { it.toString() }).noneMatch { it.contains("secret-key") }

        assertThat(stream("reconnecting", reconnectAttempt = 1, nowMs = 20_000)).isNull()
        assertThat(stream("reconnected", reconnectAttempt = 2, nowMs = 21_000)).isNull()
        assertThat(stream("streaming", bitrate = 1_800_000, droppedFrames = 12, nowMs = 30_000)).isNull()
        // Statuses for another stream id do not touch this one.
        assertThat(tracker.streamStatus("other", "stopped", true, null, null, null, null, null, null, 31_000)).isNull()
        tracker.streamStopRequested()

        val ended = stream("stopped", terminal = true, nowMs = 70_000)!!
        assertThat(ended.name).isEqualTo("bluetooth_sdk_stream_ended")
        assertThat(ended.properties)
            .containsEntry("protocol", "rtmp")
            .containsEntry("duration_ms", 60_000L)
            .containsEntry("end_state", "stopped")
            .containsEntry("stopped_by_app", true)
            .containsEntry("reconnect_attempts", 2)
            .containsEntry("bitrate", 1_800_000L)
            .containsEntry("dropped_frames", 12L)

        assertThat(stream("stopped", terminal = true, nowMs = 71_000)).isNull()
    }

    @Test
    fun `older glasses without a terminal flag end a stream on stopped, and error details lose their URLs`() {
        tracker.streamStartSettled("s2", "https://whip.example.com/whip/abc", null, null, null, null, false, "hotspot", 100, null, 0)
        assertThat(tracker.streamStatus(null, "error", null, null, null, null, null, null, null, 1_000)).isNull()
        val ended =
            tracker.streamStatus(null, "reconnect_failed", null, null, null, null, null, null, "connect to https://whip.example.com/whip/abc failed", 9_000)!!
        assertThat(ended.properties)
            .containsEntry("protocol", "whip")
            .containsEntry("end_state", "reconnect_failed")
            .containsEntry("error_code", "connect to <url> failed")
            .containsEntry("stopped_by_app", false)
    }

    @Test
    fun `a failed stream start reports the error and opens no stream`() {
        val failed = tracker.streamStartSettled("s3", "srt://host:9000", null, null, null, null, true, "none", 30_000, "stream_start_failed", 0)
        assertThat(failed.properties).containsEntry("success", false).containsEntry("error_code", "stream_start_failed").containsEntry("protocol", "srt")
        assertThat(tracker.streamStatus("s3", "stopped", true, null, null, null, null, null, null, 1_000)).isNull()
    }

    @Test
    fun `stream protocol follows the glasses scheme mapping`() {
        assertThat(BluetoothSdkUsageTracker.streamProtocol("rtmp://a")).isEqualTo("rtmp")
        assertThat(BluetoothSdkUsageTracker.streamProtocol("RTMPS://a")).isEqualTo("rtmp")
        assertThat(BluetoothSdkUsageTracker.streamProtocol("srt://a")).isEqualTo("srt")
        assertThat(BluetoothSdkUsageTracker.streamProtocol("http://a")).isEqualTo("whip")
        assertThat(BluetoothSdkUsageTracker.streamProtocol("rtmpt://a")).isEqualTo("unknown")
        assertThat(BluetoothSdkUsageTracker.streamProtocol("not a url")).isEqualTo("unknown")
    }

    @Test
    fun `a mic session ends when the source turns off or changes`() {
        assertThat(tracker.observeMic("", transcribing = false, nowMs = 0)).isNull()
        assertThat(tracker.observeMic("glasses", transcribing = false, nowMs = 1_000)).isNull()
        assertThat(tracker.observeMic("glasses", transcribing = true, nowMs = 2_000)).isNull()

        val switched = tracker.observeMic("phone", transcribing = false, nowMs = 11_000)!!
        assertThat(switched.name).isEqualTo("bluetooth_sdk_mic_session")
        assertThat(switched.properties)
            .containsEntry("mic_source", "glasses")
            .containsEntry("duration_ms", 10_000L)
            .containsEntry("local_transcription", true)

        val off = tracker.observeMic("", transcribing = false, nowMs = 14_000)!!
        assertThat(off.properties).containsEntry("mic_source", "phone").containsEntry("duration_ms", 3_000L).containsEntry("local_transcription", false)
        assertThat(tracker.observeMic("", transcribing = false, nowMs = 15_000)).isNull()
    }

    @Test
    fun `wifi and hotspot setup report outcome and latency`() {
        assertThat(tracker.wifiSetupSettled(4_000, null).properties).containsEntry("success", true).containsEntry("latency_ms", 4_000L)
        assertThat(tracker.wifiSetupSettled(15_000, "connect_timeout").properties).containsEntry("error_code", "connect_timeout")
        assertThat(tracker.hotspotStartSettled(2_500, null).name).isEqualTo("bluetooth_sdk_hotspot_started")
    }

    @Test
    fun `an OTA session is reported once with its starting versions`() {
        assertThat(ota("ota-1", "in_progress", nowMs = 0, fromBuild = "38")).isNull()
        assertThat(ota("ota-1", "step_complete", nowMs = 60_000, fromBuild = "39")).isNull()
        val done = ota("ota-1", "complete", nowMs = 300_000, fromBuild = "40")!!
        assertThat(done.name).isEqualTo("bluetooth_sdk_ota_finished")
        assertThat(done.properties)
            .containsEntry("success", true)
            .containsEntry("duration_ms", 300_000L)
            .containsEntry("from_build_number", "38")
            .containsEntry("total_steps", 2)
            .doesNotContainKey("failed_step_type")
        assertThat(ota("ota-1", "complete", nowMs = 301_000, fromBuild = "40")).isNull()

        val failed = ota("ota-2", "failed", nowMs = 0, fromBuild = "40", stepType = "bes", error = "download failed: https://ota.example.com/x.bin")!!
        assertThat(failed.properties)
            .containsEntry("success", false)
            .containsEntry("failed_step_type", "bes")
            .containsEntry("error_message", "download failed: <url>")
            .doesNotContainKey("duration_ms")
    }

    @Test
    fun `request timeouts are capped per tracker`() {
        val capped = BluetoothSdkUsageTracker(maxRequestTimeouts = 2)
        assertThat(capped.requestTimedOut("photo request")!!.properties)
            .containsEntry("operation", "photo request")
            .containsEntry("error_code", "request_timeout")
        assertThat(capped.requestTimedOut("start stream")).isNotNull()
        assertThat(capped.requestTimedOut("start stream")).isNull()
    }

    @Test
    fun `button presses carry the gallery mode`() {
        assertThat(tracker.buttonPressed("camera", "long", galleryModeEnabled = true).properties)
            .containsEntry("button_id", "camera")
            .containsEntry("press_type", "long")
            .containsEntry("gallery_mode_enabled", true)
    }

    private fun stream(
        state: String,
        terminal: Boolean? = null,
        reconnectAttempt: Int? = null,
        bitrate: Long? = null,
        droppedFrames: Long? = null,
        nowMs: Long,
    ) = tracker.streamStatus("s1", state, terminal, reconnectAttempt, bitrate, null, droppedFrames, null, null, nowMs)

    private fun ota(
        sessionId: String,
        status: String,
        nowMs: Long,
        fromBuild: String,
        stepType: String = "apk",
        error: String? = null,
    ) = tracker.otaStatus(sessionId, status, stepType, totalSteps = 2, errorMessage = error, fromBuildNumber = fromBuild, fromBesFirmwareVersion = "", fromMtkFirmwareVersion = "", nowMs = nowMs)
}
