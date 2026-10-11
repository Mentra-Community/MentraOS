package com.mentra.bluetoothsdk

/**
 * Pure decision logic for the Mentra Live usage events: one event per photo,
 * recording, stream, mic session, setup attempt, OTA attempt and timed-out
 * glasses command. It owns no threads and no I/O; [BluetoothSdkAnalytics] feeds
 * it facts and captures what it returns, and only when analytics is enabled.
 *
 * Durations are measured on the phone's clock between the start and end
 * statuses it observes. A recording or stream whose end never reaches this
 * process (the app was killed mid-stream) produces only its start.
 */
internal class BluetoothSdkUsageTracker(private val maxRequestTimeouts: Int = MAX_REQUEST_TIMEOUTS) {
    private data class OpenRecording(
        var startedAtMs: Long? = null,
        val width: Int? = null,
        val height: Int? = null,
        val fps: Int? = null,
        val save: Boolean? = null,
        val maxDurationMinutes: Int? = null,
        var stoppedByApp: Boolean = false,
    )

    private data class OpenStream(
        val streamId: String,
        val protocol: String,
        /** Set by the first live status; null while the start is still pending. */
        var startedAtMs: Long? = null,
        var reconnectAttempts: Int = 0,
        var stoppedByApp: Boolean = false,
        var bitrate: Long? = null,
        var fps: Double? = null,
        var droppedFrames: Long? = null,
        var temperatureC: Double? = null,
    )

    private data class OpenOta(
        val startedAtMs: Long,
        val fromBuildNumber: String,
        val fromBesFirmwareVersion: String,
        val fromMtkFirmwareVersion: String,
    )

    private val recordings = boundedMap<String, OpenRecording>(MAX_OPEN_RECORDINGS)
    private var stream: OpenStream? = null
    private var micSource: String? = null
    private var micStartedAtMs = 0L
    private var micTranscribed = false
    private val otaSessions = boundedMap<String, OpenOta>(MAX_OTA_SESSIONS)
    private val finishedOtaSessions = boundedMap<String, Boolean>(MAX_OTA_SESSIONS)
    private var requestTimeouts = 0

    fun photoSettled(
        size: String,
        mode: String,
        compress: String,
        save: Boolean,
        transferMethod: String,
        latencyMs: Long,
        fileSizeBytes: Long?,
        errorCode: String?,
    ): AnalyticsEvent =
        AnalyticsEvent(
            EVENT_PHOTO_TAKEN,
            buildMap {
                put("trigger", TRIGGER_API)
                putOutcome(errorCode)
                put("latency_ms", latencyMs)
                put("photo_size", size)
                put("photo_mode", mode)
                put("compress", compress)
                put("save_to_gallery", save)
                put("transfer_method", transferMethod)
                fileSizeBytes?.takeIf { it > 0 }?.let { put("file_size_bytes", it) }
            },
        )

    /** A button photo the glasses could not take; successful button photos never reach the phone. */
    fun buttonPhotoFailed(errorCode: String?): AnalyticsEvent =
        AnalyticsEvent(
            EVENT_PHOTO_TAKEN,
            buildMap {
                put("trigger", TRIGGER_BUTTON)
                putOutcome(errorCode ?: "photo_request_failed")
            },
        )

    fun buttonPressed(buttonId: String, pressType: String, galleryModeEnabled: Boolean): AnalyticsEvent =
        AnalyticsEvent(
            EVENT_BUTTON_PRESSED,
            mapOf(
                "button_id" to buttonId,
                "press_type" to pressType,
                "gallery_mode_enabled" to galleryModeEnabled,
            ),
        )

    /** Records the API parameters of a recording so its end event can report them. */
    fun videoRequested(requestId: String, width: Int, height: Int, fps: Int, save: Boolean, maxDurationMinutes: Int) {
        recordings[requestId] =
            OpenRecording(
                width = width.takeIf { it > 0 },
                height = height.takeIf { it > 0 },
                fps = fps.takeIf { it > 0 },
                save = save,
                maxDurationMinutes = maxDurationMinutes.takeIf { it > 0 },
            )
    }

    fun videoStopRequested(requestId: String) {
        recordings[requestId]?.stoppedByApp = true
    }

    /**
     * Glasses report every recording, button-started ones included, through
     * `video_recording_status`. A recording is reported once: when it stops, or
     * when a command for it fails. `not_recording` answers a stop for a recording
     * that already ended and is not a recording of its own.
     */
    fun videoStatus(requestId: String, status: String, success: Boolean, nowMs: Long): AnalyticsEvent? {
        if (requestId.isBlank()) return null
        if (success) {
            when (status) {
                "recording_started" -> {
                    val recording = recordings[requestId] ?: OpenRecording().also { recordings[requestId] = it }
                    if (recording.startedAtMs == null) recording.startedAtMs = nowMs
                    return null
                }
                "recording_stopped" -> {
                    val recording = recordings.remove(requestId) ?: return null
                    return videoEvent(requestId, recording, nowMs, errorCode = null)
                }
                else -> return null
            }
        }
        if (status == "not_recording") {
            recordings.remove(requestId)
            return null
        }
        val recording = recordings.remove(requestId) ?: OpenRecording()
        return videoEvent(requestId, recording, nowMs, errorCode = status.ifBlank { "video_recording_failed" })
    }

    private fun videoEvent(requestId: String, recording: OpenRecording, nowMs: Long, errorCode: String?) =
        AnalyticsEvent(
            EVENT_VIDEO_RECORDED,
            buildMap {
                put("trigger", if (requestId.startsWith(LOCAL_VIDEO_REQUEST_PREFIX)) TRIGGER_BUTTON else TRIGGER_API)
                putOutcome(errorCode)
                recording.startedAtMs?.let { put("duration_ms", (nowMs - it).coerceAtLeast(0)) }
                recording.width?.let { put("width", it) }
                recording.height?.let { put("height", it) }
                recording.fps?.let { put("fps", it) }
                recording.save?.let { put("save_to_gallery", it) }
                recording.maxDurationMinutes?.let { put("max_duration_minutes", it) }
                put("stopped_by_app", recording.stoppedByApp)
            },
        )

    /**
     * Opens the stream as its start command is sent, so a status that arrives
     * before `startStream` returns is still attributed to it. A new start
     * supersedes a stream that was live (the glasses stop it), so that stream is
     * reported as `replaced`.
     */
    fun streamRequested(streamId: String, streamUrl: String, nowMs: Long): AnalyticsEvent? {
        val replaced =
            stream
                ?.takeIf { it.startedAtMs != null && it.streamId != streamId }
                ?.let { streamEndedEvent(it, "replaced", errorDetails = null, nowMs = nowMs) }
        stream = OpenStream(streamId = streamId, protocol = streamProtocol(streamUrl))
        return replaced
    }

    fun streamStartSettled(
        streamUrl: String,
        width: Int?,
        height: Int?,
        fps: Int?,
        bitrate: Int?,
        captureAudio: Boolean,
        glassesNetwork: String,
        latencyMs: Long,
        errorCode: String?,
    ): AnalyticsEvent =
        AnalyticsEvent(
            EVENT_STREAM_STARTED,
            buildMap {
                putOutcome(errorCode)
                put("protocol", streamProtocol(streamUrl))
                width?.let { put("width", it) }
                height?.let { put("height", it) }
                fps?.let { put("fps", it) }
                bitrate?.let { put("bitrate", it) }
                put("capture_audio", captureAudio)
                put("glasses_network", glassesNetwork)
                put("latency_ms", latencyMs)
            },
        )

    fun streamStopRequested() {
        stream?.stoppedByApp = true
    }

    /**
     * Folds one accepted `stream_status` into the open stream and reports the
     * stream once, on its terminal status. Glasses with stream revisions flag the
     * terminal status; older glasses only send a final `stopped` or
     * `reconnect_failed`. A stream that never went live ends silently: its
     * `bluetooth_sdk_stream_started` already reported the failure.
     */
    fun streamStatus(
        streamId: String?,
        state: String,
        terminal: Boolean?,
        reconnectAttempt: Int?,
        bitrate: Long?,
        fps: Double?,
        droppedFrames: Long?,
        temperatureC: Double?,
        errorDetails: String?,
        nowMs: Long,
    ): AnalyticsEvent? {
        val open = stream ?: return null
        if (!streamId.isNullOrBlank() && streamId != open.streamId) return null
        if (state in LIVE_STREAM_STATES && open.startedAtMs == null) open.startedAtMs = nowMs
        reconnectAttempt?.let { open.reconnectAttempts = maxOf(open.reconnectAttempts, it) }
        bitrate?.let { open.bitrate = it }
        fps?.let { open.fps = it }
        droppedFrames?.let { open.droppedFrames = it }
        temperatureC?.let { open.temperatureC = it }
        val ended = terminal == true || (terminal == null && state in LEGACY_TERMINAL_STREAM_STATES)
        if (!ended) return null
        stream = null
        if (open.startedAtMs == null) return null
        return streamEndedEvent(open, state, errorDetails, nowMs)
    }

    private fun streamEndedEvent(open: OpenStream, endState: String, errorDetails: String?, nowMs: Long) =
        AnalyticsEvent(
            EVENT_STREAM_ENDED,
            buildMap {
                put("protocol", open.protocol)
                open.startedAtMs?.let { put("duration_ms", (nowMs - it).coerceAtLeast(0)) }
                put("end_state", endState)
                put("stopped_by_app", open.stoppedByApp)
                put("reconnect_attempts", open.reconnectAttempts)
                sanitizedDetail(errorDetails)?.let { put("error_code", it) }
                open.bitrate?.let { put("bitrate", it) }
                open.fps?.let { put("fps", it) }
                open.droppedFrames?.let { put("dropped_frames", it) }
                open.temperatureC?.let { put("temperature_c", it) }
            },
        )

    /**
     * Follows the active mic source. A session ends when the source turns off or
     * changes; `local_transcription` is true if on-device transcription ran at
     * any point during it.
     */
    fun observeMic(currentMic: String, transcribing: Boolean, nowMs: Long): AnalyticsEvent? {
        val next = currentMic.takeIf { it.isNotBlank() }
        val previous = micSource
        if (next == previous) {
            if (next != null && transcribing) micTranscribed = true
            return null
        }
        val ended =
            previous?.let {
                AnalyticsEvent(
                    EVENT_MIC_SESSION,
                    mapOf(
                        "duration_ms" to (nowMs - micStartedAtMs).coerceAtLeast(0),
                        "mic_source" to it,
                        "local_transcription" to micTranscribed,
                    ),
                )
            }
        micSource = next
        micStartedAtMs = nowMs
        micTranscribed = next != null && transcribing
        return ended
    }

    fun wifiSetupSettled(latencyMs: Long, errorCode: String?): AnalyticsEvent =
        AnalyticsEvent(EVENT_WIFI_SETUP, buildMap { putOutcome(errorCode); put("latency_ms", latencyMs) })

    fun hotspotStartSettled(latencyMs: Long, errorCode: String?): AnalyticsEvent =
        AnalyticsEvent(EVENT_HOTSPOT_STARTED, buildMap { putOutcome(errorCode); put("latency_ms", latencyMs) })

    /**
     * One event per OTA session, on `complete` or `failed`. The "from" versions are
     * the glasses versions when this process first saw the session in progress.
     */
    fun otaStatus(
        sessionId: String,
        status: String,
        stepType: String,
        totalSteps: Int,
        errorMessage: String?,
        fromBuildNumber: String,
        fromBesFirmwareVersion: String,
        fromMtkFirmwareVersion: String,
        nowMs: Long,
    ): AnalyticsEvent? {
        if (finishedOtaSessions.containsKey(sessionId)) return null
        if (status != OTA_COMPLETE && status != OTA_FAILED) {
            if (status != OTA_IDLE && !otaSessions.containsKey(sessionId)) {
                otaSessions[sessionId] =
                    OpenOta(nowMs, fromBuildNumber, fromBesFirmwareVersion, fromMtkFirmwareVersion)
            }
            return null
        }
        finishedOtaSessions[sessionId] = true
        val open = otaSessions.remove(sessionId)
        val success = status == OTA_COMPLETE
        return AnalyticsEvent(
            EVENT_OTA_FINISHED,
            buildMap {
                put("success", success)
                if (!success) {
                    stepType.takeIf { it.isNotBlank() }?.let { put("failed_step_type", it) }
                    sanitizedDetail(errorMessage)?.let { put("error_message", it) }
                }
                if (totalSteps > 0) put("total_steps", totalSteps)
                open?.let { session ->
                    put("duration_ms", (nowMs - session.startedAtMs).coerceAtLeast(0))
                    session.fromBuildNumber.takeIf { it.isNotBlank() }?.let { put("from_build_number", it) }
                    session.fromBesFirmwareVersion.takeIf { it.isNotBlank() }?.let { put("from_bes_firmware_version", it) }
                    session.fromMtkFirmwareVersion.takeIf { it.isNotBlank() }?.let { put("from_mtk_firmware_version", it) }
                }
            },
        )
    }

    /** At most [maxRequestTimeouts] per SDK instance, so a failure loop cannot run up event volume. */
    fun requestTimedOut(operation: String): AnalyticsEvent? {
        if (requestTimeouts >= maxRequestTimeouts) return null
        requestTimeouts++
        return AnalyticsEvent(EVENT_REQUEST_FAILED, mapOf("operation" to operation, "error_code" to "request_timeout"))
    }

    private fun MutableMap<String, Any>.putOutcome(errorCode: String?) {
        put("success", errorCode == null)
        sanitizedDetail(errorCode)?.let { put("error_code", it) }
    }

    companion object {
        const val EVENT_PHOTO_TAKEN = "bluetooth_sdk_photo_taken"
        const val EVENT_VIDEO_RECORDED = "bluetooth_sdk_video_recorded"
        const val EVENT_BUTTON_PRESSED = "bluetooth_sdk_button_pressed"
        const val EVENT_STREAM_STARTED = "bluetooth_sdk_stream_started"
        const val EVENT_STREAM_ENDED = "bluetooth_sdk_stream_ended"
        const val EVENT_MIC_SESSION = "bluetooth_sdk_mic_session"
        const val EVENT_WIFI_SETUP = "bluetooth_sdk_wifi_setup"
        const val EVENT_HOTSPOT_STARTED = "bluetooth_sdk_hotspot_started"
        const val EVENT_OTA_FINISHED = "bluetooth_sdk_ota_finished"
        const val EVENT_REQUEST_FAILED = "bluetooth_sdk_request_failed"

        const val MAX_REQUEST_TIMEOUTS = 100
        private const val MAX_OPEN_RECORDINGS = 16
        private const val MAX_OTA_SESSIONS = 16
        private const val MAX_DETAIL_LENGTH = 200
        private const val TRIGGER_API = "api"
        private const val TRIGGER_BUTTON = "button"
        /** Glasses report button-capture photo failures under this request id (ASG MediaCaptureService). */
        const val LOCAL_PHOTO_REQUEST_ID = "local"
        /** Button-started recordings use `local_video_<ts>_<rand>` request ids on the glasses. */
        const val LOCAL_VIDEO_REQUEST_PREFIX = "local_video_"
        private const val OTA_COMPLETE = "complete"
        private const val OTA_FAILED = "failed"
        private const val OTA_IDLE = "idle"
        private val LEGACY_TERMINAL_STREAM_STATES = setOf("stopped", "reconnect_failed")
        private val LIVE_STREAM_STATES = setOf("streaming", "reconnected")
        private val URL_PATTERN = Regex("""[A-Za-z][A-Za-z0-9+.\-]*://\S+""")

        /** Mirrors the glasses' scheme mapping in ASG StreamCommandHandler. */
        fun streamProtocol(streamUrl: String): String =
            when (streamUrl.trim().substringBefore("://", "").lowercase()) {
                "srt" -> "srt"
                "rtmp", "rtmps" -> "rtmp"
                "http", "https" -> "whip"
                else -> "unknown"
            }

        /** Free-text details may carry stream or upload URLs; those never leave the phone. */
        fun sanitizedDetail(value: String?): String? =
            value
                ?.replace(URL_PATTERN, "<url>")
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
                ?.take(MAX_DETAIL_LENGTH)

        private fun <K, V> boundedMap(capacity: Int): MutableMap<K, V> =
            object : LinkedHashMap<K, V>() {
                override fun removeEldestEntry(eldest: MutableMap.MutableEntry<K, V>?): Boolean = size > capacity
            }
    }
}
