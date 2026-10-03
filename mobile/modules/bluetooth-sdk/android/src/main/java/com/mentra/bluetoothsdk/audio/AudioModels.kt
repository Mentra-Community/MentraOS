package com.mentra.bluetoothsdk

enum class MicPreference(val value: String) {
    AUTO("auto"),
    PHONE("phone"),
    GLASSES("glasses"),
    BLUETOOTH("bluetooth"),
}

data class MicPcmEvent(
    val pcm: ByteArray,
    val sampleRate: Int,
    val bitsPerSample: Int,
    val channels: Int,
    val encoding: String,
    val voiceActivityDetectionEnabled: Boolean,
    /**
     * Which microphone produced this buffer, as [MicTypes]: `"glasses"`, `"phone"`, `"bluetooth"`.
     *
     * Carried per frame rather than inferred, because the SDK can move the source mid-stream when
     * one becomes unavailable. A consumer that promised the far end a specific microphone — an ACS
     * call, for instance — has no other way to tell that the audio it is forwarding is still the
     * one it advertised. Empty when the SDK has not selected a microphone.
     */
    val source: String,
) {
    constructor(values: Map<String, Any>) : this(
        pcm = values["pcm"] as? ByteArray ?: ByteArray(0),
        sampleRate = numberValue(values, "sampleRate") ?: SAMPLE_RATE,
        bitsPerSample = numberValue(values, "bitsPerSample") ?: BITS_PER_SAMPLE,
        channels = numberValue(values, "channels") ?: CHANNELS,
        encoding = stringValue(values, "encoding") ?: ENCODING,
        voiceActivityDetectionEnabled =
            boolValue(values, "voiceActivityDetectionEnabled")
                ?: BluetoothSdkDefaults.VOICE_ACTIVITY_DETECTION_ENABLED,
        source = stringValue(values, "source") ?: "",
    )

    fun toMap(): Map<String, Any> =
        mapOf(
            "type" to "mic_pcm",
            "pcm" to pcm,
            "sampleRate" to sampleRate,
            "bitsPerSample" to bitsPerSample,
            "channels" to channels,
            "encoding" to encoding,
            "voiceActivityDetectionEnabled" to voiceActivityDetectionEnabled,
            "source" to source,
        )

    companion object {
        const val SAMPLE_RATE = 16_000
        const val BITS_PER_SAMPLE = 16
        const val CHANNELS = 1
        const val ENCODING = "pcm_s16le"
    }
}

data class MicLc3Event(
    val lc3: ByteArray,
    val sampleRate: Int,
    val channels: Int,
    val encoding: String,
    val frameDurationMs: Int,
    val frameSizeBytes: Int,
    val bitrate: Int,
    val packetizedFromGlasses: Boolean,
    val voiceActivityDetectionEnabled: Boolean,
) {
    constructor(values: Map<String, Any>) : this(
        lc3 = values["lc3"] as? ByteArray ?: ByteArray(0),
        sampleRate = numberValue(values, "sampleRate") ?: SAMPLE_RATE,
        channels = numberValue(values, "channels") ?: CHANNELS,
        encoding = stringValue(values, "encoding") ?: ENCODING,
        frameDurationMs = numberValue(values, "frameDurationMs") ?: FRAME_DURATION_MS,
        frameSizeBytes = numberValue(values, "frameSizeBytes") ?: DEFAULT_FRAME_SIZE_BYTES,
        bitrate = numberValue(values, "bitrate") ?: DEFAULT_BITRATE,
        packetizedFromGlasses = boolValue(values, "packetizedFromGlasses") ?: false,
        voiceActivityDetectionEnabled =
            boolValue(values, "voiceActivityDetectionEnabled")
                ?: BluetoothSdkDefaults.VOICE_ACTIVITY_DETECTION_ENABLED,
    )

    fun toMap(): Map<String, Any> =
        mapOf(
            "type" to "mic_lc3",
            "lc3" to lc3,
            "sampleRate" to sampleRate,
            "channels" to channels,
            "encoding" to encoding,
            "frameDurationMs" to frameDurationMs,
            "frameSizeBytes" to frameSizeBytes,
            "bitrate" to bitrate,
            "packetizedFromGlasses" to packetizedFromGlasses,
            "voiceActivityDetectionEnabled" to voiceActivityDetectionEnabled,
        )

    companion object {
        const val SAMPLE_RATE = 16_000
        const val CHANNELS = 1
        const val ENCODING = "lc3"
        const val FRAME_DURATION_MS = 10
        const val DEFAULT_FRAME_SIZE_BYTES = 60
        const val DEFAULT_BITRATE = DEFAULT_FRAME_SIZE_BYTES * 8 * (1000 / FRAME_DURATION_MS)
    }
}

internal data class MicHealth(
    val sequenceGapEvents: Long,
    val decodeFailures: Long,
    val lastLc3ReceivedAt: Long?,
    val lastPcmProducedAt: Long?,
) {
    fun toMap(): Map<String, Any> =
        buildMap {
            put("sequenceGapEvents", sequenceGapEvents)
            put("decodeFailures", decodeFailures)
            lastLc3ReceivedAt?.let { put("lastLc3ReceivedAt", it) }
            lastPcmProducedAt?.let { put("lastPcmProducedAt", it) }
        }
}

data class LocalTranscriptionEvent(
    val text: String,
    val isFinal: Boolean,
    val values: Map<String, Any>,
)

data class GlassesMediaVolumeGetResult(
    val level: Int?,
    val statusCode: Int?,
    val values: Map<String, Any>,
) {
    companion object {
        fun fromMap(values: Map<String, Any>): GlassesMediaVolumeGetResult =
            GlassesMediaVolumeGetResult(
                level = numberValue(values, "level"),
                statusCode = (values["statusCode"] as? Number)?.toInt(),
                values = values,
            )
    }
}

data class GlassesMediaVolumeSetResult(
    val statusCode: Int?,
    val values: Map<String, Any>,
) {
    companion object {
        fun fromMap(values: Map<String, Any>): GlassesMediaVolumeSetResult =
            GlassesMediaVolumeSetResult(
                statusCode = (values["statusCode"] as? Number)?.toInt(),
                values = values,
            )
    }
}
