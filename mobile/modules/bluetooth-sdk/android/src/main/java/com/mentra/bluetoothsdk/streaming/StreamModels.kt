package com.mentra.bluetoothsdk

data class StreamVideoConfig @JvmOverloads constructor(
    val width: Int? = null,
    val height: Int? = null,
    val bitrate: Int? = null,
    val fps: Int? = null,
    val minBitrateBps: Int? = null,
    val initialBitrateBps: Int? = null,
) {
    fun toMap(): Map<String, Any> =
        listOfNotNull(
            width?.let { "width" to it },
            height?.let { "height" to it },
            bitrate?.let { "bitrate" to it },
            minBitrateBps?.let { "minBitrateBps" to it },
            initialBitrateBps?.let { "initialBitrateBps" to it },
            // ASG stream parsers shipped with the BLE key named "frameRate".
            fps?.let { "frameRate" to it },
        ).toMap()

    companion object {
        @JvmStatic
        fun fromMap(values: Map<String, Any>?): StreamVideoConfig? {
            values ?: return null
            return StreamVideoConfig(
                width = numberValue(values, "width"),
                height = numberValue(values, "height"),
                bitrate = numberValue(values, "bitrate"),
                fps = numberValue(values, "fps"),
                minBitrateBps = numberValue(values, "minBitrateBps"),
                initialBitrateBps = numberValue(values, "initialBitrateBps"),
            )
        }
    }
}

data class StreamAudioConfig @JvmOverloads constructor(
    val bitrate: Int? = null,
    val sampleRate: Int? = null,
    val echoCancellation: Boolean? = null,
    val noiseSuppression: Boolean? = null,
) {
    fun toMap(): Map<String, Any> =
        listOfNotNull(
            bitrate?.let { "bitrate" to it },
            sampleRate?.let { "sampleRate" to it },
            echoCancellation?.let { "echoCancellation" to it },
            noiseSuppression?.let { "noiseSuppression" to it },
        ).toMap()

    companion object {
        @JvmStatic
        fun fromMap(values: Map<String, Any>?): StreamAudioConfig? {
            values ?: return null
            return StreamAudioConfig(
                bitrate = numberValue(values, "bitrate"),
                sampleRate = numberValue(values, "sampleRate"),
                echoCancellation = values["echoCancellation"] as? Boolean,
                noiseSuppression = values["noiseSuppression"] as? Boolean,
            )
        }
    }
}

/** Effective video settings reported by the glasses after defaults and clamps. */
data class StreamResolvedVideoConfig @JvmOverloads constructor(
    /** Encoded output width sent to the stream endpoint. */
    val width: Int,
    /** Encoded output height sent to the stream endpoint. */
    val height: Int,
    /** Native camera buffer width selected before crop/downscale. */
    val captureWidth: Int? = null,
    /** Native camera buffer height selected before crop/downscale. */
    val captureHeight: Int? = null,
    /** Encoded video bitrate in bits per second. */
    val bitrate: Int,
    /** Resolved capture/encode frame rate. */
    val fps: Double,
) {
    fun toMap(): Map<String, Any> =
        buildMap {
            put("width", width)
            put("height", height)
            captureWidth?.let { put("captureWidth", it) }
            captureHeight?.let { put("captureHeight", it) }
            put("bitrate", bitrate)
            put("fps", fps)
        }

    companion object {
        @JvmStatic
        fun fromMap(values: Map<String, Any>?): StreamResolvedVideoConfig? {
            values ?: return null
            return StreamResolvedVideoConfig(
                width = numberValue(values, "width") ?: return null,
                height = numberValue(values, "height") ?: return null,
                captureWidth = numberValue(values, "captureWidth"),
                captureHeight = numberValue(values, "captureHeight"),
                bitrate = numberValue(values, "bitrate") ?: return null,
                fps = doubleValue(values, "fps") ?: return null,
            )
        }
    }
}

data class StreamResolvedAudioConfig @JvmOverloads constructor(
    val bitrate: Int? = null,
    val sampleRate: Int? = null,
    val echoCancellation: Boolean? = null,
    val noiseSuppression: Boolean? = null,
) {
    fun toMap(): Map<String, Any> =
        buildMap {
            bitrate?.let { put("bitrate", it) }
            sampleRate?.let { put("sampleRate", it) }
            echoCancellation?.let { put("echoCancellation", it) }
            noiseSuppression?.let { put("noiseSuppression", it) }
        }

    companion object {
        @JvmStatic
        fun fromMap(values: Map<String, Any>?): StreamResolvedAudioConfig? {
            values ?: return null
            return StreamResolvedAudioConfig(
                bitrate = numberValue(values, "bitrate"),
                sampleRate = numberValue(values, "sampleRate"),
                echoCancellation = boolValue(values, "echoCancellation"),
                noiseSuppression = boolValue(values, "noiseSuppression"),
            )
        }
    }
}

enum class StreamTransport(val value: String) {
    RTMP("rtmp"),
    SRT("srt"),
    WHIP("whip");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): StreamTransport? =
            when (value?.lowercase()) {
                "rtmp" -> RTMP
                "srt" -> SRT
                "whip" -> WHIP
                else -> null
            }
    }
}

data class StreamResolvedConfig @JvmOverloads constructor(
    val transport: StreamTransport? = null,
    val video: StreamResolvedVideoConfig? = null,
    val audio: StreamResolvedAudioConfig? = null,
) {
    fun toMap(): Map<String, Any> =
        buildMap {
            transport?.let { put("transport", it.value) }
            video?.let { put("video", it.toMap()) }
            audio?.let { put("audio", it.toMap()) }
        }

    companion object {
        @JvmStatic
        fun fromMap(values: Map<String, Any>?): StreamResolvedConfig? {
            values ?: return null
            return StreamResolvedConfig(
                transport = StreamTransport.fromValue(stringValue(values, "transport")),
                video = StreamResolvedVideoConfig.fromMap(stringMapValue(values["video"])),
                audio = StreamResolvedAudioConfig.fromMap(stringMapValue(values["audio"])),
            )
        }
    }
}

/** Live encoder and device telemetry reported by the glasses while streaming. */
data class StreamLiveStats @JvmOverloads constructor(
    val bitrate: Long? = null,
    val fps: Double? = null,
    val droppedFrames: Long? = null,
    val duration: Long? = null,
    val temperatureC: Double? = null,
) {
    fun toMap(): Map<String, Any> =
        buildMap {
            bitrate?.let { put("bitrate", it) }
            fps?.let { put("fps", it) }
            droppedFrames?.let { put("droppedFrames", it) }
            duration?.let { put("duration", it) }
            temperatureC?.let { put("temperatureC", it) }
        }

    companion object {
        @JvmStatic
        fun fromMap(values: Map<String, Any>?): StreamLiveStats? {
            values ?: return null
            return StreamLiveStats(
                bitrate = longValue(values, "bitrate"),
                fps = doubleValue(values, "fps"),
                droppedFrames = longValue(values, "droppedFrames"),
                duration = longValue(values, "duration"),
                temperatureC = doubleValue(values, "temperatureC"),
            )
        }
    }
}

data class StreamRequest @JvmOverloads constructor(
    val streamUrl: String,
    val streamId: String = "",
    val sound: Boolean = true,
    val video: StreamVideoConfig? = null,
    val audio: StreamAudioConfig? = null,
    val authToken: String? = null,
    val captureAudio: Boolean = true,
) {
    fun toMap(): Map<String, Any> =
        buildMap {
            put("type", "start_stream")
            put("streamUrl", streamUrl)
            put("streamId", streamId)
            put("sound", sound)
            video?.toMap()?.takeIf { it.isNotEmpty() }?.let { put("video", it) }
            audio?.toMap()?.takeIf { it.isNotEmpty() }?.let { put("audio", it) }
            authToken?.takeIf { it.isNotEmpty() }?.let { put("authToken", it) }
            if (!captureAudio) put("captureAudio", false)
        }

    companion object {
        @JvmStatic
        fun fromMap(values: Map<String, Any>): StreamRequest =
            StreamRequest(
                streamUrl =
                    (values["streamUrl"] ?: values["rtmpUrl"] ?: values["srtUrl"] ?: values["whipUrl"]) as? String
                        ?: "",
                streamId = values["streamId"] as? String ?: "",
                sound = values["sound"] as? Boolean ?: true,
                video = StreamVideoConfig.fromMap(stringMapValue(values["video"])),
                audio = StreamAudioConfig.fromMap(stringMapValue(values["audio"])),
                authToken = values["authToken"] as? String ?: values["auth_token"] as? String,
                captureAudio = boolValue(values, "captureAudio") ?: boolValue(values, "ca") ?: true,
            )
    }
}

internal data class StreamKeepAliveRequest @JvmOverloads constructor(
    val streamId: String,
    val ackId: String,
) {
    fun toMap(): Map<String, Any> =
        mapOf(
            "type" to "keep_stream_alive",
            "streamId" to streamId,
            "ackId" to ackId,
        )

    companion object {
        @JvmStatic
        fun fromMap(values: Map<String, Any>): StreamKeepAliveRequest =
            StreamKeepAliveRequest(
                streamId = values["streamId"] as? String ?: "",
                ackId = values["ackId"] as? String ?: "",
            )
    }
}

enum class StreamState(val value: String) {
    INITIALIZING("initializing"),
    STREAMING("streaming"),
    STOPPING("stopping"),
    STOPPED("stopped"),
    RECONNECTING("reconnecting"),
    RECONNECTED("reconnected"),
    RECONNECT_FAILED("reconnect_failed"),
    ERROR("error");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): StreamState? =
            when (value?.lowercase()) {
                "initializing", "starting", "connecting" -> INITIALIZING
                "streaming", "streaming_started", "active" -> STREAMING
                "stopping" -> STOPPING
                "stopped", "not_streaming", "disconnected", "timeout" -> STOPPED
                "reconnecting" -> RECONNECTING
                "reconnected" -> RECONNECTED
                "reconnect_failed" -> RECONNECT_FAILED
                "error", "error_not_streaming" -> ERROR
                else -> null
            }
    }
}

enum class StreamStatusKind(val value: String) {
    LIFECYCLE("lifecycle"),
    RECONNECT("reconnect"),
    ERROR("error"),
    SNAPSHOT("snapshot"),
}

sealed interface StreamStatus {
    val kind: StreamStatusKind
    val state: StreamState
    val streamId: String?
    val timestamp: Long?
    val resolvedConfig: StreamResolvedConfig?

    fun toMap(): Map<String, Any> {
        val values = mutableMapOf<String, Any>(
            "kind" to kind.value,
            "status" to state.value,
        )
        streamId?.takeIf { it.isNotBlank() }?.let { values["streamId"] = it }
        timestamp?.let { values["timestamp"] = it }
        resolvedConfig?.let { values["resolvedConfig"] = it.toMap() }

        when (this) {
            is Lifecycle -> Unit
            is Reconnecting -> {
                values["attempt"] = attempt
                values["maxAttempts"] = maxAttempts
                values["reason"] = reason
            }
            is Reconnected -> values["attempt"] = attempt
            is ReconnectFailed -> values["maxAttempts"] = maxAttempts
            is Error -> values["errorDetails"] = errorDetails
            is Snapshot -> {
                values["streaming"] = streaming
                values["reconnecting"] = reconnecting
                attempt?.let { values["attempt"] = it }
            }
        }

        return values
    }

    fun toEventMap(): Map<String, Any> = toMap() + mapOf("type" to "stream_status")

    data class Lifecycle(
        override val state: StreamState,
        override val streamId: String?,
        override val timestamp: Long?,
        override val resolvedConfig: StreamResolvedConfig?,
    ) : StreamStatus {
        override val kind: StreamStatusKind = StreamStatusKind.LIFECYCLE
    }

    data class Reconnecting(
        override val streamId: String?,
        val attempt: Int,
        val maxAttempts: Int,
        val reason: String,
        override val timestamp: Long?,
        override val resolvedConfig: StreamResolvedConfig?,
    ) : StreamStatus {
        override val kind: StreamStatusKind = StreamStatusKind.RECONNECT
        override val state: StreamState = StreamState.RECONNECTING
    }

    data class Reconnected(
        override val streamId: String?,
        val attempt: Int,
        override val timestamp: Long?,
        override val resolvedConfig: StreamResolvedConfig?,
    ) : StreamStatus {
        override val kind: StreamStatusKind = StreamStatusKind.RECONNECT
        override val state: StreamState = StreamState.RECONNECTED
    }

    data class ReconnectFailed(
        override val streamId: String?,
        val maxAttempts: Int,
        override val timestamp: Long?,
        override val resolvedConfig: StreamResolvedConfig?,
    ) : StreamStatus {
        override val kind: StreamStatusKind = StreamStatusKind.RECONNECT
        override val state: StreamState = StreamState.RECONNECT_FAILED
    }

    data class Error(
        override val streamId: String?,
        val errorDetails: String,
        override val timestamp: Long?,
        override val resolvedConfig: StreamResolvedConfig?,
    ) : StreamStatus {
        override val kind: StreamStatusKind = StreamStatusKind.ERROR
        override val state: StreamState = StreamState.ERROR
    }

    data class Snapshot(
        override val state: StreamState,
        val streaming: Boolean,
        val reconnecting: Boolean,
        override val streamId: String?,
        val attempt: Int?,
        override val timestamp: Long?,
        override val resolvedConfig: StreamResolvedConfig?,
    ) : StreamStatus {
        override val kind: StreamStatusKind = StreamStatusKind.SNAPSHOT
    }

    companion object {
        @JvmStatic
        fun fromMap(values: Map<String, Any>): StreamStatus {
            val rawState = stringValue(values, "status")
            val streaming = boolValue(values, "streaming")
            val reconnecting = boolValue(values, "reconnecting") ?: false
            val streamId = stringValue(values, "streamId")
            val timestamp = longValue(values, "timestamp")
            val resolvedConfig = StreamResolvedConfig.fromMap(stringMapValue(values["resolvedConfig"]))
            val attempt = numberValue(values, "attempt")
            val maxAttempts = numberValue(values, "maxAttempts") ?: 0
            val parsedState = StreamState.fromValue(rawState)

            if (streaming != null || hasAnyKey(values, "reconnecting")) {
                return Snapshot(
                    state = when {
                        reconnecting -> StreamState.RECONNECTING
                        streaming == true -> StreamState.STREAMING
                        parsedState != null -> parsedState
                        else -> StreamState.STOPPED
                    },
                    streaming = streaming == true,
                    reconnecting = reconnecting,
                    streamId = streamId,
                    attempt = attempt,
                    timestamp = timestamp,
                    resolvedConfig = resolvedConfig,
                )
            }

            val state = parsedState
                ?: return Error(
                    streamId = streamId,
                    errorDetails = rawState?.let { "Unknown stream status: $it" } ?: "Missing stream status",
                    timestamp = timestamp,
                    resolvedConfig = resolvedConfig,
                )

            return when (state) {
                StreamState.RECONNECTING -> Reconnecting(
                    streamId = streamId,
                    attempt = attempt ?: 0,
                    maxAttempts = maxAttempts,
                    reason = stringValue(values, "reason") ?: "",
                    timestamp = timestamp,
                    resolvedConfig = resolvedConfig,
                )
                StreamState.RECONNECTED -> Reconnected(
                    streamId = streamId,
                    attempt = attempt ?: 0,
                    timestamp = timestamp,
                    resolvedConfig = resolvedConfig,
                )
                StreamState.RECONNECT_FAILED -> ReconnectFailed(
                    streamId = streamId,
                    maxAttempts = maxAttempts,
                    timestamp = timestamp,
                    resolvedConfig = resolvedConfig,
                )
                StreamState.ERROR -> Error(
                    streamId = streamId,
                    errorDetails = stringValue(values, "errorDetails")
                        ?: if (rawState == "error_not_streaming") "not_streaming" else "Unknown stream error",
                    timestamp = timestamp,
                    resolvedConfig = resolvedConfig,
                )
                else -> Lifecycle(
                    state = state,
                    streamId = streamId,
                    timestamp = timestamp,
                    resolvedConfig = resolvedConfig,
                )
            }
        }
    }
}

data class StreamStatusEvent(
    val status: StreamStatus,
    val stats: StreamLiveStats? = null,
) {
    // True when the glasses will retry the failed publisher themselves
    // (emitting side lands in PR #3488); absent on older firmware and on
    // events not parsed from a glasses status map. Carried here instead of
    // on StreamStatus.Error so the public Error shape stays unchanged.
    var willRetry: Boolean? = null
        private set

    constructor(values: Map<String, Any>) : this(
        status = StreamStatus.fromMap(values),
        stats = StreamLiveStats.fromMap(stringMapValue(values["stats"])),
    ) {
        willRetry = boolValue(values, "willRetry")
    }

    val state: StreamState get() = status.state
    val streamId: String? get() = status.streamId
    val resolvedConfig: StreamResolvedConfig? get() = status.resolvedConfig
    val values: Map<String, Any>
        get() = buildMap {
            putAll(status.toEventMap())
            stats?.let { put("stats", it.toMap()) }
            willRetry?.let { put("willRetry", it) }
        }
}

data class KeepAliveAckEvent(
    val streamId: String,
    val ackId: String,
    val timestamp: Long?,
) {
    constructor(values: Map<String, Any>) : this(
        streamId = stringValue(values, "streamId").orEmpty(),
        ackId = stringValue(values, "ackId").orEmpty(),
        timestamp = longValue(values, "timestamp"),
    )

    val values: Map<String, Any>
        get() = buildMap {
            put("type", "keep_alive_ack")
            put("streamId", streamId)
            put("ackId", ackId)
            timestamp?.let { put("timestamp", it) }
        }
}
