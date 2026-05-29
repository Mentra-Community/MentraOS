package com.mentra.bluetoothsdk

enum class PhotoSize(val value: String) {
    SMALL("small"),
    MEDIUM("medium"),
    LARGE("large"),
    FULL("full");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): PhotoSize =
            values().firstOrNull { it.value == value } ?: MEDIUM
    }
}

enum class ButtonPhotoSize(val value: String) {
    SMALL("small"),
    MEDIUM("medium"),
    LARGE("large");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): ButtonPhotoSize =
            values().firstOrNull { it.value == value } ?: MEDIUM
    }
}

enum class PhotoCompression(val value: String) {
    NONE("none"),
    MEDIUM("medium"),
    HEAVY("heavy");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): PhotoCompression =
            values().firstOrNull { it.value == value } ?: NONE
    }
}

data class ButtonPhotoSettings(
    val size: ButtonPhotoSize,
)

data class ButtonVideoRecordingSettings(
    val width: Int,
    val height: Int,
    val fps: Int,
)

enum class CameraFov(val fov: Int, val roiPosition: Int) {
    STANDARD(118, 0),
    WIDE(118, 0),
}

data class PhotoRequest @JvmOverloads constructor(
    val requestId: String,
    val appId: String,
    val size: PhotoSize,
    val webhookUrl: String,
    val authToken: String? = null,
    val compress: PhotoCompression = PhotoCompression.MEDIUM,
    val flash: Boolean = true,
    val sound: Boolean = true,
    /** Sensor exposure time for this capture only (ns), or null for auto exposure */
    val exposureTimeNs: Double? = null,
) {
    companion object {
        /** Mirrors iOS `BluetoothSdkModule` defaults for keys omitted from the JS bridge. */
        @JvmStatic
        fun fromMap(values: Map<String, Any>): PhotoRequest {
            val rawExp = values["exposureTimeNs"] ?: values["exposure_time_ns"]
            val exposureTimeNs: Double? =
                when (rawExp) {
                    is Number -> rawExp.toDouble().takeIf { it.isFinite() && it > 0 }
                    else -> null
                }
            return PhotoRequest(
                requestId = stringValue(values, "requestId", "request_id").orEmpty(),
                appId = stringValue(values, "appId", "app_id").orEmpty(),
                size = PhotoSize.fromValue(stringValue(values, "size") ?: "medium"),
                webhookUrl = stringValue(values, "webhookUrl", "webhook_url").orEmpty(),
                authToken = stringValue(values, "authToken", "auth_token")?.takeIf { it.isNotBlank() },
                compress = PhotoCompression.fromValue(stringValue(values, "compress") ?: "none"),
                flash = boolValue(values, "flash") ?: true,
                sound = boolValue(values, "sound") ?: true,
                exposureTimeNs = exposureTimeNs,
            )
        }
    }
}

enum class RgbLedAction(val value: String) {
    ON("on"),
    OFF("off");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): RgbLedAction =
            values().firstOrNull { it.value == value } ?: OFF
    }
}

enum class RgbLedColor(val value: String) {
    RED("red"),
    GREEN("green"),
    BLUE("blue"),
    ORANGE("orange"),
    WHITE("white");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): RgbLedColor? =
            values().firstOrNull { it.value == value }
    }
}

data class RgbLedRequest @JvmOverloads constructor(
    val requestId: String,
    val packageName: String?,
    val action: RgbLedAction,
    val color: RgbLedColor?,
    val onDurationMs: Int,
    val offDurationMs: Int,
    val count: Int,
)

data class VideoRecordingRequest(
    val requestId: String,
    val save: Boolean,
    val sound: Boolean,
)

data class GalleryStatusEvent(
    val values: Map<String, Any>,
)

sealed interface PhotoResponse {
    val state: String
    val requestId: String
    val timestamp: Long

    fun toMap(): Map<String, Any> =
        when (this) {
            is Success -> mapOf(
                "state" to state,
                "requestId" to requestId,
                "uploadUrl" to uploadUrl,
                "timestamp" to timestamp,
            )

            is Error -> mutableMapOf<String, Any>(
                "state" to state,
                "requestId" to requestId,
                "timestamp" to timestamp,
                "errorMessage" to errorMessage,
            ).apply {
                if (!errorCode.isNullOrBlank()) {
                    this["errorCode"] = errorCode
                }
            }
        }

    fun toEventMap(): Map<String, Any> = toMap() + mapOf("type" to "photo_response")

    data class Success(
        override val requestId: String,
        val uploadUrl: String,
        override val timestamp: Long,
    ) : PhotoResponse {
        override val state: String = "success"
    }

    data class Error(
        override val requestId: String,
        val errorCode: String?,
        val errorMessage: String,
        override val timestamp: Long,
    ) : PhotoResponse {
        override val state: String = "error"
    }

    companion object {
        fun fromMap(values: Map<String, Any>): PhotoResponse {
            val requestId = stringValue(values, "requestId").orEmpty()
            val timestamp = longValue(values, "timestamp") ?: System.currentTimeMillis()
            val state = stringValue(values, "state")?.lowercase()
            return if (state == "success") {
                val uploadUrl = stringValue(values, "uploadUrl").orEmpty()
                Success(requestId = requestId, uploadUrl = uploadUrl, timestamp = timestamp)
            } else {
                Error(
                    requestId = requestId,
                    errorCode = stringValue(values, "errorCode"),
                    errorMessage = stringValue(values, "errorMessage") ?: "Unknown photo error",
                    timestamp = timestamp,
                )
            }
        }
    }
}

data class PhotoResponseEvent(
    val response: PhotoResponse,
) {
    constructor(values: Map<String, Any>) : this(PhotoResponse.fromMap(values))

    val requestId: String get() = response.requestId
    val values: Map<String, Any> get() = response.toEventMap()
}
