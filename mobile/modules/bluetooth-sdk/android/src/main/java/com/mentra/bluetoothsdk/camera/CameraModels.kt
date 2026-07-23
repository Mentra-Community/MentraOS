package com.mentra.bluetoothsdk

import org.json.JSONObject
import java.util.UUID

internal fun generatedCameraRequestId(prefix: String): String =
    "$prefix-${System.currentTimeMillis()}-${UUID.randomUUID().toString().take(8)}"

internal fun nonBlankRequestId(requestId: String?): String? =
    requestId?.trim()?.takeIf { it.isNotEmpty() }

enum class PhotoSize(val value: String) {
    LOW("low"),
    MEDIUM("medium"),
    HIGH("high"),
    MAX("max");

    companion object {
        @JvmStatic
        fun normalizeLegacy(value: String?): String =
            when (value) {
                "small" -> LOW.value
                "large" -> HIGH.value
                "full" -> MAX.value
                else -> value ?: MEDIUM.value
            }

        @JvmStatic
        fun fromValue(value: String?): PhotoSize {
            val normalized = normalizeLegacy(value)
            return values().firstOrNull { it.value == normalized } ?: MEDIUM
        }
    }
}

enum class ButtonPhotoSize(val value: String) {
    LOW("low"),
    MEDIUM("medium"),
    HIGH("high"),
    MAX("max");

    companion object {
        @JvmStatic
        fun normalizeLegacy(value: String?): String = PhotoSize.normalizeLegacy(value)

        @JvmStatic
        fun fromValue(value: String?): ButtonPhotoSize {
            val normalized = normalizeLegacy(value)
            return values().firstOrNull { it.value == normalized } ?: MEDIUM
        }
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

data class PhotoCaptureDefaults(
    val size: PhotoSize? = null,
    val mfnr: Boolean? = null,
    val zsl: Boolean? = null,
    val noiseReduction: Boolean? = null,
    val edgeEnhancement: Boolean? = null,
    val ispDigitalGain: Int? = null,
    val ispAnalogGain: String? = null,
    val aeExposureDivisor: Int? = null,
    val isoCap: Int? = null,
    val compress: String? = null,
    val sound: Boolean? = null,
    val resetCaptureTuning: Boolean = false,
)

data class VideoRecordingDefaults(
    val width: Int,
    val height: Int,
    val fps: Int,
)

enum class CameraRoiPosition(val value: Int, val label: String) {
    CENTER(0, "center"),
    BOTTOM(1, "bottom"),
    TOP(2, "top");

    companion object {
        @JvmStatic
        fun fromValue(value: Int?): CameraRoiPosition =
            values().firstOrNull { it.value == value } ?: CENTER

        @JvmStatic
        fun fromName(value: String?): CameraRoiPosition =
            values().firstOrNull { it.label == value } ?: CENTER
    }
}

class CameraFov @JvmOverloads constructor(
    fov: Int = DEFAULT_FOV,
    roiPosition: CameraRoiPosition = DEFAULT_ROI_POSITION,
) {
    val fov: Int = fov.coerceIn(MIN_FOV, MAX_FOV)
    val roiPosition: CameraRoiPosition = roiPosition

    companion object {
        const val MIN_FOV = 62
        const val MAX_FOV = 118
        const val DEFAULT_FOV = 118
        const val NARROW_FOV = 82
        const val STANDARD_FOV = 102
        @JvmField
        val DEFAULT_ROI_POSITION = CameraRoiPosition.CENTER
        @JvmField
        val NARROW = CameraFov(NARROW_FOV, DEFAULT_ROI_POSITION)
        @JvmField
        val STANDARD = CameraFov(STANDARD_FOV, DEFAULT_ROI_POSITION)
        @JvmField
        val WIDE = CameraFov(MAX_FOV, DEFAULT_ROI_POSITION)
    }
}

data class CameraFovResult(
    val requestId: String,
    val fov: Int,
    val roiPosition: CameraRoiPosition,
    val timestamp: Long,
) {
    val values: Map<String, Any>
        get() =
            mapOf(
                "requestId" to requestId,
                "fov" to fov,
                "roiPosition" to roiPosition.label,
                "timestamp" to timestamp,
            )

    companion object {
        @JvmStatic
        fun fromAck(
            ack: SettingsAckEvent,
            fallback: CameraFov,
        ): CameraFovResult {
            if (ack.status == "error") {
                throw BluetoothSdkException(
                    ack.errorCode ?: "camera_fov_failed",
                    ack.errorMessage ?: "Camera FOV request failed.",
                )
            }
            if (!ack.hardwareApplied) {
                throw BluetoothSdkException(
                    "camera_fov_not_applied",
                    "Camera FOV was saved but not applied to hardware.",
                )
            }

            return CameraFovResult(
                requestId = ack.requestId,
                fov = ack.fov ?: fallback.fov,
                roiPosition = CameraRoiPosition.fromValue(ack.roiPosition ?: fallback.roiPosition.value),
                timestamp = ack.timestamp,
            )
        }
    }
}

enum class PhotoMode(val value: String) {
    PHOTO("photo"),
    TEXT("text");

    companion object {
        @JvmStatic
        fun fromValue(value: String?): PhotoMode =
            values().firstOrNull { it.value == value } ?: PHOTO
    }
}

data class PhotoRequest @JvmOverloads constructor(
    val requestId: String = generatedCameraRequestId("photo"),
    val size: PhotoSize,
    val webhookUrl: String,
    val authToken: String? = null,
    val compress: PhotoCompression = PhotoCompression.MEDIUM,
    val save: Boolean = false,
    val sound: Boolean = true,
    /** Sensor exposure time for this capture only (ns), or null for auto exposure */
    val exposureTimeNs: Double? = null,
    /** Sensor ISO for this capture only. Only used when exposureTimeNs enables manual exposure. */
    val iso: Int? = null,
    val aeExposureDivisor: Int? = null,
    val isoCap: Int? = null,
    val noiseReduction: Boolean? = null,
    val edgeEnhancement: Boolean? = null,
    val mfnr: Boolean? = null,
    val zsl: Boolean? = null,
    val ispDigitalGain: Int? = null,
    val ispAnalogGain: String? = null,
    val resetCaptureTuning: Boolean? = null,
    val mode: PhotoMode = PhotoMode.PHOTO,
    /** `direct` disables BLE fallback; `ble` skips direct upload; `auto` tries both. */
    val transferMethod: String = "auto",
) {
    companion object {
        private fun transferMethodFromValue(value: Any?): String {
            if (value == null) return "auto"
            val raw = value as? String
                ?: throw IllegalArgumentException(
                    "Invalid transferMethod ${value::class.java.simpleName}. Expected auto, direct, or ble."
                )
            return raw.takeIf { it == "auto" || it == "direct" || it == "ble" }
                ?: throw IllegalArgumentException(
                    "Invalid transferMethod \"$raw\". Expected auto, direct, or ble."
                )
        }

        /** Mirrors iOS `BluetoothSdkModule` defaults for keys omitted from the JS bridge. */
        @JvmStatic
        fun fromMap(values: Map<String, Any>): PhotoRequest {
            val rawExp = values["exposureTimeNs"] ?: values["exposure_time_ns"]
            val exposureTimeNs: Double? =
                when (rawExp) {
                    is Number -> rawExp.toDouble().takeIf { it.isFinite() && it > 0 }
                    else -> null
                }
            val rawIso = values["iso"]
            val iso: Int? =
                when (rawIso) {
                    is Number -> rawIso.toDouble().takeIf { it.isFinite() && it > 0 }?.let { value ->
                        when {
                            value > Int.MAX_VALUE.toDouble() -> Int.MAX_VALUE
                            else -> value.toInt()
                        }
                    }
                    else -> null
                }
            val aeDivisor =
                numberValue(values, "aeExposureDivisor")?.takeIf { it > 1 }
            val isoCap = numberValue(values, "isoCap")?.takeIf { it > 0 }
            val ispDigitalGain = numberValue(values, "ispDigitalGain")
            val ispAnalogGain = stringValue(values, "ispAnalogGain")

            return PhotoRequest(
                requestId = nonBlankRequestId(stringValue(values, "requestId", "request_id"))
                    ?: generatedCameraRequestId("photo"),
                size = PhotoSize.fromValue(stringValue(values, "size") ?: "medium"),
                webhookUrl = stringValue(values, "webhookUrl", "webhook_url").orEmpty(),
                authToken = stringValue(values, "authToken", "auth_token")?.takeIf { it.isNotBlank() },
                compress = PhotoCompression.fromValue(stringValue(values, "compress") ?: "none"),
                save = boolValue(values, "save", "saveToGallery") ?: false,
                sound = boolValue(values, "sound") ?: true,
                mode = PhotoMode.fromValue(stringValue(values, "mode")),
                transferMethod = transferMethodFromValue(values["transferMethod"]),
                exposureTimeNs = exposureTimeNs,
                iso = iso,
                aeExposureDivisor = aeDivisor,
                isoCap = isoCap,
                noiseReduction = boolValue(values, "noiseReduction"),
                edgeEnhancement = boolValue(values, "edgeEnhancement"),
                mfnr = boolValue(values, "mfnr"),
                zsl = boolValue(values, "zsl"),
                ispDigitalGain = ispDigitalGain,
                ispAnalogGain = ispAnalogGain,
            )
        }

        /** Adds optional scan-mode tuning fields to a `take_photo` JSON payload. */
        @JvmStatic
        fun appendScanFields(
            json: JSONObject,
            request: PhotoRequest,
        ) {
            request.aeExposureDivisor?.let { json.put("aeExposureDivisor", it) }
            request.isoCap?.let { json.put("isoCap", it) }
            request.noiseReduction?.let { json.put("noiseReduction", it) }
            request.edgeEnhancement?.let { json.put("edgeEnhancement", it) }
            request.mfnr?.let { json.put("mfnr", it) }
            request.zsl?.let { json.put("zsl", it) }
            request.ispDigitalGain?.let { json.put("ispDigitalGain", it) }
            request.ispAnalogGain?.let { json.put("ispAnalogGain", it) }
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
    // Optional per-recording overrides; 0 means "use the saved button-video default".
    val width: Int = 0,
    val height: Int = 0,
    val fps: Int = 0,
    // Optional auto-stop timer in minutes; 0 = record until stopped/interrupted.
    val maxRecordingTimeMinutes: Int = 0,
)

data class VideoRecordingStatusEvent(
    val values: Map<String, Any>,
) {
    val requestId: String get() = stringValue(values, "requestId").orEmpty()
    val success: Boolean get() = boolValue(values, "success") ?: false
    val status: String get() = stringValue(values, "status").orEmpty()
    val details: String? get() = stringValue(values, "details")
    val timestamp: Long get() = longValue(values, "timestamp") ?: System.currentTimeMillis()
    val data: Map<String, Any>? get() = stringMapValue(values["data"])
}

data class MediaUploadEvent(
    val values: Map<String, Any>,
) {
    val type: String get() = stringValue(values, "type").orEmpty()
    val requestId: String get() = stringValue(values, "requestId").orEmpty()
    val mediaUrl: String? get() = stringValue(values, "mediaUrl")
    val errorMessage: String? get() = stringValue(values, "errorMessage")
    val mediaType: Int? get() = numberValue(values, "mediaType")
    val timestamp: Long get() = longValue(values, "timestamp") ?: System.currentTimeMillis()
    val isSuccess: Boolean get() = type == "media_success"
    val isVideo: Boolean get() = mediaType == 2
}

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
            ).withOptionalPhotoMetadata(this)

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
        val photoUrl: String?,
        val statusUrl: String?,
        val contentType: String?,
        val fileSizeBytes: Long?,
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
            val success = state == "success" || boolValue(values, "success") == true
            return if (success) {
                val uploadUrl = stringValue(values, "uploadUrl").orEmpty()
                Success(
                    requestId = requestId,
                    uploadUrl = uploadUrl,
                    photoUrl = stringValue(values, "photoUrl"),
                    statusUrl = stringValue(values, "statusUrl"),
                    contentType = stringValue(values, "contentType", "mimeType"),
                    fileSizeBytes =
                        longValue(values, "fileSizeBytes")
                            ?: longValue(values, "bytes")
                            ?: longValue(values, "size"),
                    timestamp = timestamp,
                )
            } else {
                Error(
                    requestId = requestId,
                    errorCode = stringValue(values, "errorCode"),
                    errorMessage =
                        stringValue(values, "errorMessage", "error") ?: "Unknown photo error",
                    timestamp = timestamp,
                )
            }
        }
    }
}

private fun Map<String, Any>.withOptionalPhotoMetadata(
    success: PhotoResponse.Success,
): Map<String, Any> =
    toMutableMap().apply {
        success.photoUrl?.takeIf { it.isNotBlank() }?.let { this["photoUrl"] = it }
        success.statusUrl?.takeIf { it.isNotBlank() }?.let { this["statusUrl"] = it }
        success.contentType?.takeIf { it.isNotBlank() }?.let { this["contentType"] = it }
        success.fileSizeBytes?.let { this["fileSizeBytes"] = it }
    }

data class PhotoResponseEvent(
    val response: PhotoResponse,
) {
    constructor(values: Map<String, Any>) : this(PhotoResponse.fromMap(values))

    val requestId: String get() = response.requestId
    val values: Map<String, Any> get() = response.toEventMap()
}

data class PhotoStatusEvent(
    val values: Map<String, Any>,
) {
    val requestId: String get() = stringValue(values, "requestId").orEmpty()
    val status: String get() = stringValue(values, "status").orEmpty()
    val timestamp: Long get() = longValue(values, "timestamp") ?: System.currentTimeMillis()
    val resolvedConfig: Map<String, Any>? get() = stringMapValue(values["resolvedConfig"])
    val requestedCaptureConfig: Map<String, Any>? get() = stringMapValue(values["requestedCaptureConfig"])
    val meteredPreview: Map<String, Any>? get() = stringMapValue(values["meteredPreview"])
    val captureMetadata: Map<String, Any>? get() = stringMapValue(values["captureMetadata"])
    val errorCode: String? get() = stringValue(values, "errorCode")
    val errorMessage: String? get() = stringValue(values, "errorMessage")
}

data class CameraStatusEvent(
    val values: Map<String, Any>,
) {
    val requestId: String get() = stringValue(values, "requestId").orEmpty()
    val state: String get() = stringValue(values, "state").orEmpty()
    val timestamp: Long get() = longValue(values, "timestamp") ?: System.currentTimeMillis()
    val errorCode: String? get() = stringValue(values, "errorCode")
    val errorMessage: String? get() = stringValue(values, "errorMessage")
}
