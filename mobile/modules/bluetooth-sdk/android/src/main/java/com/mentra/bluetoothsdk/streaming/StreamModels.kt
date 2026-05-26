package com.mentra.bluetoothsdk

data class StreamVideoConfig @JvmOverloads constructor(
    val width: Int? = null,
    val height: Int? = null,
    val bitrate: Int? = null,
    val fps: Int? = null,
) {
    fun toMap(): Map<String, Any> =
        listOfNotNull(
            width?.let { "width" to it },
            height?.let { "height" to it },
            bitrate?.let { "bitrate" to it },
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

data class StreamRequest @JvmOverloads constructor(
    val streamUrl: String,
    val streamId: String = "",
    val keepAlive: Boolean = true,
    val keepAliveIntervalSeconds: Int = 15,
    val sound: Boolean = true,
    val video: StreamVideoConfig? = null,
    val audio: StreamAudioConfig? = null,
    val extraValues: Map<String, Any> = emptyMap(),
) {
    fun toMap(): Map<String, Any> {
        val values = extraValues.toMutableMap()
        values["type"] = "start_stream"
        values["streamUrl"] = streamUrl
        values["streamId"] = streamId
        values["keepAlive"] = keepAlive
        values["keepAliveIntervalSeconds"] = keepAliveIntervalSeconds
        // The camera light is a privacy indicator and cannot be disabled by SDK callers.
        values["flash"] = true
        values["sound"] = sound
        video?.toMap()?.takeIf { it.isNotEmpty() }?.let { values["video"] = it }
        audio?.toMap()?.takeIf { it.isNotEmpty() }?.let { values["audio"] = it }
        return values
    }

    companion object {
        @JvmStatic
        fun fromMap(values: Map<String, Any>): StreamRequest =
            StreamRequest(
                streamUrl =
                    (values["streamUrl"] ?: values["rtmpUrl"] ?: values["srtUrl"] ?: values["whipUrl"]) as? String
                        ?: "",
                streamId = values["streamId"] as? String ?: "",
                keepAlive = values["keepAlive"] as? Boolean ?: true,
                keepAliveIntervalSeconds = (values["keepAliveIntervalSeconds"] as? Number)?.toInt() ?: 15,
                sound = values["sound"] as? Boolean ?: true,
                video = StreamVideoConfig.fromMap(stringMapValue(values["video"])),
                audio = StreamAudioConfig.fromMap(stringMapValue(values["audio"])),
                extraValues = values,
            )
    }
}

data class StreamKeepAliveRequest @JvmOverloads constructor(
    val streamId: String,
    val ackId: String,
    val extraValues: Map<String, Any> = emptyMap(),
) {
    fun toMap(): Map<String, Any> {
        val values = extraValues.toMutableMap()
        values["type"] = "keep_stream_alive"
        values["streamId"] = streamId
        values["ackId"] = ackId
        return values
    }

    companion object {
        @JvmStatic
        fun fromMap(values: Map<String, Any>): StreamKeepAliveRequest =
            StreamKeepAliveRequest(
                streamId = values["streamId"] as? String ?: "",
                ackId = values["ackId"] as? String ?: "",
                extraValues = values,
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

    fun toMap(): Map<String, Any> {
        val values = mutableMapOf<String, Any>(
            "kind" to kind.value,
            "status" to state.value,
        )
        streamId?.takeIf { it.isNotBlank() }?.let { values["streamId"] = it }
        timestamp?.let { values["timestamp"] = it }

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
    ) : StreamStatus {
        override val kind: StreamStatusKind = StreamStatusKind.LIFECYCLE
    }

    data class Reconnecting(
        override val streamId: String?,
        val attempt: Int,
        val maxAttempts: Int,
        val reason: String,
        override val timestamp: Long?,
    ) : StreamStatus {
        override val kind: StreamStatusKind = StreamStatusKind.RECONNECT
        override val state: StreamState = StreamState.RECONNECTING
    }

    data class Reconnected(
        override val streamId: String?,
        val attempt: Int,
        override val timestamp: Long?,
    ) : StreamStatus {
        override val kind: StreamStatusKind = StreamStatusKind.RECONNECT
        override val state: StreamState = StreamState.RECONNECTED
    }

    data class ReconnectFailed(
        override val streamId: String?,
        val maxAttempts: Int,
        override val timestamp: Long?,
    ) : StreamStatus {
        override val kind: StreamStatusKind = StreamStatusKind.RECONNECT
        override val state: StreamState = StreamState.RECONNECT_FAILED
    }

    data class Error(
        override val streamId: String?,
        val errorDetails: String,
        override val timestamp: Long?,
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
            val attempt = numberValue(values, "attempt")
            val maxAttempts = numberValue(values, "maxAttempts") ?: 0

            if (streaming != null || hasAnyKey(values, "reconnecting")) {
                return Snapshot(
                    state = when {
                        reconnecting -> StreamState.RECONNECTING
                        streaming == true -> StreamState.STREAMING
                        else -> StreamState.STOPPED
                    },
                    streaming = streaming == true,
                    reconnecting = reconnecting,
                    streamId = streamId,
                    attempt = attempt,
                    timestamp = timestamp,
                )
            }

            val state = StreamState.fromValue(rawState)
                ?: return Error(
                    streamId = streamId,
                    errorDetails = rawState?.let { "Unknown stream status: $it" } ?: "Missing stream status",
                    timestamp = timestamp,
                )

            return when (state) {
                StreamState.RECONNECTING -> Reconnecting(
                    streamId = streamId,
                    attempt = attempt ?: 0,
                    maxAttempts = maxAttempts,
                    reason = stringValue(values, "reason") ?: "",
                    timestamp = timestamp,
                )
                StreamState.RECONNECTED -> Reconnected(
                    streamId = streamId,
                    attempt = attempt ?: 0,
                    timestamp = timestamp,
                )
                StreamState.RECONNECT_FAILED -> ReconnectFailed(
                    streamId = streamId,
                    maxAttempts = maxAttempts,
                    timestamp = timestamp,
                )
                StreamState.ERROR -> Error(
                    streamId = streamId,
                    errorDetails = stringValue(values, "errorDetails")
                        ?: if (rawState == "error_not_streaming") "not_streaming" else "Unknown stream error",
                    timestamp = timestamp,
                )
                else -> Lifecycle(
                    state = state,
                    streamId = streamId,
                    timestamp = timestamp,
                )
            }
        }
    }
}

data class StreamStatusEvent(
    val status: StreamStatus,
) {
    constructor(values: Map<String, Any>) : this(StreamStatus.fromMap(values))

    val state: StreamState get() = status.state
    val streamId: String? get() = status.streamId
    val values: Map<String, Any> get() = status.toEventMap()
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
