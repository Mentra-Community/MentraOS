package com.mentra.bluetoothsdk.utils

import java.nio.ByteBuffer
import java.io.IOException
import java.util.UUID

import android.content.Context
import android.util.Log

import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceStore

import mentraos.ble.MentraosBle.DisplayText
import mentraos.ble.MentraosBle.ClearDisplay
import mentraos.ble.MentraosBle.DisconnectRequest
import mentraos.ble.MentraosBle.PhoneToGlasses
import mentraos.ble.MentraosBle.DisplayImage
import mentraos.ble.MentraosBle.CanvasCreateComponent
import mentraos.ble.MentraosBle.CanvasUpdateImage
import mentraos.ble.MentraosBle.CanvasUpdateText
import mentraos.ble.MentraosBle.CanvasDeleteComponent
import mentraos.ble.MentraosBle.CanvasClear
import mentraos.ble.MentraosBle.CanvasComponentType
import mentraos.ble.MentraosBle.BatteryStateRequest
import mentraos.ble.MentraosBle.MicStateConfig
import mentraos.ble.MentraosBle.BrightnessConfig
import mentraos.ble.MentraosBle.AutoBrightnessConfig
import mentraos.ble.MentraosBle.HeadUpAngleConfig
import mentraos.ble.MentraosBle.DisplayDistanceConfig
import mentraos.ble.MentraosBle.DisplayHeightConfig
import mentraos.ble.MentraosBle.VadEnabledConfig

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject


object NexBluetoothConstants {
    val MAIN_SERVICE_UUID: UUID = UUID.fromString("00004860-0000-1000-8000-00805f9b34fb")
    val WRITE_CHAR_UUID: UUID = UUID.fromString("000071FF-0000-1000-8000-00805f9b34fb")
    val NOTIFY_CHAR_UUID: UUID = UUID.fromString("000070FF-0000-1000-8000-00805f9b34fb")
    val CLIENT_CHARACTERISTIC_CONFIG_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
}

object NexDisplayConstants {
    const val DISPLAY_WIDTH: Int = 488
    const val DISPLAY_USE_WIDTH: Int = 488 // How much of the display to use
    const val FONT_MULTIPLIER: Float = 1.0f / 50.0f
    const val OLD_FONT_SIZE: Int = 21 // Font size
    const val FONT_DIVIDER: Float = 2.0f
    const val LINES_PER_SCREEN: Int = 5 // Lines per screen

    /** Matches dashboard depth slider in app settings (1-4); values outside range clamp. */
    const val DASHBOARD_DEPTH_MIN: Int = 1
    const val DASHBOARD_DEPTH_MAX: Int = 4
}

object NexBluetoothPacketTypes {
    const val PACKET_TYPE_JSON: Byte = 0x01.toByte()
    const val PACKET_TYPE_PROTOBUF: Byte = 0x02.toByte()
    const val PACKET_TYPE_AUDIO: Byte = 0xA0.toByte()
    const val PACKET_TYPE_IMAGE: Byte = 0xB0.toByte()
}

object NexProtobufUtils {
    private const val TAG = "NexProtobufUtils"

    private const val WHITELIST_CMD: Int = 0x04

    // Characters the Nex font can render: letters, digits, whitespace, and a small
    // punctuation set. Everything else (CJK, emoji, smart quotes, …) is stripped when
    // Chinese captions are off. Compiled once — sanitizeDisplayText runs on every
    // caption update (high frequency), so we don't rebuild it per call.
    private val UNSUPPORTED_GLYPH_REGEX = Regex("""[^A-Za-z0-9 \r\n.,!?;:\-\[\]\(\)\{\}'"+=/]""")

    /**
     * Sanitize text bound for the glasses. When Chinese captions are disabled (the
     * default) the Nex font can't render CJK/emoji/etc., so em-dashes are normalised
     * to hyphens and any unsupported glyph is dropped. When enabled, text passes
     * through untouched. Every text path that reaches the display funnels through
     * here so the filter behaves identically for captions, text walls, and layouts.
     */
    private fun sanitizeDisplayText(text: String): String {
        val chineseCaptionsEnabled = DeviceStore.get("bluetooth", "nex_chinese_captions") as? Boolean ?: false
        if (chineseCaptionsEnabled) return text
        return text.replace("—", "-").replace(UNSUPPORTED_GLYPH_REGEX, "")
    }

    /**
     * Maps dashboard depth to the value Nex firmware expects in [DisplayDistanceConfig.distance_cm].
     * The protobuf field is still named `distance_cm`, but Nex treats it as a **tier** 1–4, not centimeters.
     * Keep in sync with iOS `NexDashboardDisplayWire.depthToWireTier`.
     */
    fun dashboardDepthToDistanceCm(depth: Int): Int {
        return depth.coerceIn(
            NexDisplayConstants.DASHBOARD_DEPTH_MIN,
            NexDisplayConstants.DASHBOARD_DEPTH_MAX
        )
    }

    data class AppInfo(
        val id: String,
        val name: String
    )

    fun getWhitelistChunks(maxChunkSize: Int): List<ByteArray> {
        // Define the hardcoded whitelist
        val apps = listOf(AppInfo("com.augment.os", "AugmentOS"))
        val whitelistJson = createWhitelistJson(apps)

        Bridge.log("Creating chunks for hardcoded whitelist: $whitelistJson")

        // Convert JSON to bytes and split into chunks
        return createWhitelistChunks(whitelistJson, maxChunkSize)
    }

    fun createBmpChunksForNexGlasses(streamId: String, bmpData: ByteArray, totalChunks: Int, bmpChunkSize: Int): List<ByteArray> {
        val chunks = mutableListOf<ByteArray>()
        Bridge.log("Creating $totalChunks chunks from ${bmpData.size} bytes")
        
        // Parse hex stream ID to bytes (e.g., "002A" -> 0x00, 0x2A)
        val streamIdInt = streamId.toInt(16)
        
        repeat(totalChunks) { i ->
            val start = i * bmpChunkSize
            val end = minOf(start + bmpChunkSize, bmpData.size)
            val chunk = bmpData.copyOfRange(start, end)
            
            val header = ByteArray(4 + chunk.size).apply {
                this[0] = NexBluetoothPacketTypes.PACKET_TYPE_IMAGE // 0xB0
                this[1] = (streamIdInt shr 8).toByte() // Stream ID high byte
                this[2] = streamIdInt.toByte()         // Stream ID low byte
                this[3] = i.toByte()                   // Chunk index
                System.arraycopy(chunk, 0, this, 4, chunk.size)
            }
            chunks.add(header)
        }
        return chunks
    }

    /**
     * Gets the current protobuf schema version from the compiled protobuf descriptor
     */
    fun getProtobufSchemaVersion(context: Context): Int {
        return try {
            // Get the protobuf descriptor and extract the schema version
            val fileDescriptor = mentraos.ble.MentraosBle.getDescriptor().file
            
            Log.d(TAG, "Proto file descriptor: ${fileDescriptor.name}")
            
            // Method 1: Try to access the custom mentra_schema_version option
            try {
                // Get the file options from the descriptor
                val options = fileDescriptor.options
                Log.d(TAG, "Got file options: $options")
                
                // Try to access the custom option using the extension registry
                try {
                    // Look for the generated extension in the MentraosBle class
                    mentraos.ble.MentraosBle::class.java.declaredFields.forEach { field ->
                        if (field.name.contains("schema", ignoreCase = true) || 
                            field.name.contains("version", ignoreCase = true)) {
                            Log.d(TAG, "Found potential version field: ${field.name}")
                            field.isAccessible = true
                            try {
                                val value = field.get(null)
                                if (value is com.google.protobuf.Extension<*, *>) {
                                    @Suppress("UNCHECKED_CAST")
                                    val ext = value as com.google.protobuf.Extension<com.google.protobuf.DescriptorProtos.FileOptions, Int>
                                    if (options.hasExtension(ext)) {
                                        val version = options.getExtension(ext)
                                        Log.d(TAG, "Found schema version via extension: $version")
                                        return version
                                    }
                                }
                            } catch (fieldException: Exception) {
                                Log.d(TAG, "Field access failed for ${field.name}: ${fieldException.message}")
                            }
                        }
                    }
                } catch (extensionException: Exception) {
                    Log.d(TAG, "Extension search failed: ${extensionException.message}")
                }
                
            } catch (optionsException: Exception) {
                Log.d(TAG, "Options access failed: ${optionsException.message}")
            }
            
            // Method 2: Try to read from the actual proto file content
            try {
                val protoVersion = readProtoVersionFromProject(context)
                if (protoVersion != null) {
                    Log.d(TAG, "Read proto version from project: $protoVersion")
                    return protoVersion.toInt()
                }
            } catch (projectException: Exception) {
                Log.d(TAG, "Project file reading failed: ${projectException.message}")
            }
            
            Log.w(TAG, "Could not extract protobuf schema version dynamically, using fallback")
            1 // Fallback to version 1
            
        } catch (e: Exception) {
            Log.e(TAG, "Error getting protobuf schema version: ${e.message}", e)
            1 // Fallback to version 1
        }
    }

    fun generateClearDisplayRequestCommandBytes(): ByteArray {
        // Create the clear display protobuf message
        val clearDisplay = ClearDisplay.newBuilder()
            .build()
        val phoneToGlasses = PhoneToGlasses.newBuilder()
            // .setMsgId("clear_disp_001")
            .setClearDisplay(clearDisplay)
            .build();
        return generateProtobufCommandBytes(phoneToGlasses);
    }

    fun generateVersionRequestCommandBytes(): ByteArray {
        // VersionRequest/VersionResponse removed from the BLE schema; fw_version now comes via DeviceInfo.
        Bridge.log("Nex: generateVersionRequestCommandBytes is a no-op after schema removal")
        return ByteArray(0)
    }

    fun generateDisconnectRequestCommandBytes(): ByteArray {
        val disconnectRequest = DisconnectRequest.newBuilder().build()
        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setDisconnect(disconnectRequest)
            .build()
        return generateProtobufCommandBytes(phoneToGlasses)
    }

    fun generateBatteryStateRequestCommandBytes(): ByteArray {
        Bridge.log("Nex: === SENDING BATTERY STATUS QUERY TO GLASSES ===")
        val batteryStateRequest = BatteryStateRequest.newBuilder().build()
        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setBatteryState(batteryStateRequest)
            .build()
        return generateProtobufCommandBytes(phoneToGlasses)
    }

    fun generateDisplayImageCommandBytes(streamId: String, totalChunks: Int, width: Int, height: Int): ByteArray {
        Bridge.log("=== SENDING IMAGE DISPLAY COMMAND TO GLASSES ===")
        Bridge.log("Image Stream ID: $streamId")
        Bridge.log("Total Chunks: $totalChunks")
        Bridge.log("Image Position: X=0, Y=0")
        Bridge.log("Image Dimensions: ${width}x$height")
        Bridge.log("Image Encoding: raw")
        
        val displayImage = DisplayImage.newBuilder()
            .setStreamId(streamId)
            .setTotalChunks(totalChunks)
            .setX(0)
            .setY(0)
            .setWidth(width)
            .setHeight(height)
            .setEncoding("raw")
            .build()

        // Create the PhoneToGlasses using its builder and set the DisplayImage with msg_id
        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setMsgId("img_start_1")
            .setDisplayImage(displayImage)
            .build()
        return generateProtobufCommandBytes(phoneToGlasses)
    }

    /**
     * Canvas: create (or replace) a full-screen bitmap component. The firmware infers the bitmap
     * pool from the id (10..13); we use a single fixed id for the full-screen image. Pixels follow
     * via [generateCanvasUpdateImageCommandBytes] + the 0xB0 chunk stream.
     */
    fun generateCanvasCreateBitmapCommandBytes(id: Int, x: Int, y: Int, width: Int, height: Int): ByteArray {
        // Negative geometry would serialize as a huge unsigned varint on the
        // wire — clamp to the drawable range before it reaches the firmware.
        val create = CanvasCreateComponent.newBuilder()
            .setId(id)
            .setType(CanvasComponentType.CANVAS_BITMAP)
            .setX(x.coerceAtLeast(0))
            .setY(y.coerceAtLeast(0))
            .setWidth(width.coerceAtLeast(1))
            .setHeight(height.coerceAtLeast(1))
            .build()
        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setCanvasCreateComponent(create)
            .build()
        return generateProtobufCommandBytes(phoneToGlasses)
    }

    /** Canvas: create (or replace) a text component (TEXTBOX). Content follows via CanvasUpdateText. */
    fun generateCanvasCreateTextboxCommandBytes(
        id: Int, x: Int, y: Int, width: Int, height: Int, borderWidth: Int, borderRadius: Int
    ): ByteArray {
        val create = CanvasCreateComponent.newBuilder()
            .setId(id)
            .setType(CanvasComponentType.CANVAS_TEXTBOX)
            .setX(x)
            .setY(y)
            .setWidth(width)
            .setHeight(height)
            .setBorderWidth(borderWidth)
            .setBorderRadius(borderRadius)
            .build()
        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setCanvasCreateComponent(create)
            .build()
        return generateProtobufCommandBytes(phoneToGlasses)
    }

    /** Canvas: set the text of a TEXTBOX / SCROLL_TEXTBOX component. */
    fun generateCanvasUpdateTextCommandBytes(id: Int, text: String, scrollOffset: Int = 0): ByteArray {
        val update = CanvasUpdateText.newBuilder()
            .setId(id)
            .setText(sanitizeDisplayText(text))
            .setScrollOffset(scrollOffset)
            .build()
        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setCanvasUpdateText(update)
            .build()
        return generateProtobufCommandBytes(phoneToGlasses)
    }

    /** Canvas: delete a single component by id. */
    fun generateCanvasDeleteComponentCommandBytes(id: Int): ByteArray {
        val del = CanvasDeleteComponent.newBuilder().setId(id).build()
        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setCanvasDeleteComponent(del)
            .build()
        return generateProtobufCommandBytes(phoneToGlasses)
    }

    /** Canvas: delete all components and exit the canvas view. */
    fun generateCanvasClearCommandBytes(): ByteArray {
        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setCanvasClear(CanvasClear.newBuilder().build())
            .build()
        return generateProtobufCommandBytes(phoneToGlasses)
    }

    /** Canvas: begin streaming a 1-bit BMP into an existing bitmap component. */
    fun generateCanvasUpdateImageCommandBytes(id: Int, streamId: String, totalChunks: Int): ByteArray {
        val update = CanvasUpdateImage.newBuilder()
            .setId(id)
            .setStreamId(streamId)
            .setTotalChunks(totalChunks)
            .build()
        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setCanvasUpdateImage(update)
            .build()
        return generateProtobufCommandBytes(phoneToGlasses)
    }

    fun generateDisplayTextCommandBytes(text: String): ByteArray {
        Bridge.log("Nex: === SENDING TEXT TO GLASSES ===")
        Bridge.log("Nex: Text: \"$text\"")
        Bridge.log("Nex: Text Length: ${text.length} characters")

        val displayText = sanitizeDisplayText(text)

        val textNewBuilder = DisplayText.newBuilder()
            .setColor(10000)
            .setText(displayText)
            .setSize(48)
            .setX(20)
            .setY(260)
            .build()

        // Create the PhoneToGlasses using its builder and set the DisplayText
        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setDisplayText(textNewBuilder)
            .build()

        return generateProtobufCommandBytes(phoneToGlasses)
    }

    fun generateHeadUpAngleConfigCommandBytes(angle: Int): ByteArray {
        val headUpAngleConfig = HeadUpAngleConfig.newBuilder().setAngle(angle).build()
        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setHeadUpAngle(headUpAngleConfig)
            .build()
        Bridge.log("Nex: Sent headUp angle command => Angle: $angle")
        return generateProtobufCommandBytes(phoneToGlasses)
    }

    fun generateDisplayHeightCommandBytes(height: Int): ByteArray {
        val clampedHeight = height.coerceIn(0, 8)

        Bridge.log("Nex: === SENDING DISPLAY HEIGHT COMMAND TO GLASSES ===")
        Bridge.log("Nex: Display height: $clampedHeight (0-8)")
        val displayHeightConfig = DisplayHeightConfig.newBuilder()
            .setHeight(clampedHeight)
            .build()

        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setDisplayHeight(displayHeightConfig)
            .build()

        Bridge.log("Nex: Sent display height command => Height: $clampedHeight")

        return generateProtobufCommandBytes(phoneToGlasses)
    }

    fun generateDisplayDistanceCommandBytes(distanceCm: Int): ByteArray {
        val tier = distanceCm.coerceIn(
            NexDisplayConstants.DASHBOARD_DEPTH_MIN,
            NexDisplayConstants.DASHBOARD_DEPTH_MAX
        )
        Bridge.log("Nex: === SENDING DISPLAY DISTANCE COMMAND TO GLASSES ===")
        Bridge.log("Nex: Display distance tier (distance_cm field): $tier")

        val displayDistanceConfig = DisplayDistanceConfig.newBuilder()
            .setDistanceCm(tier)
            .build()

        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setDisplayDistance(displayDistanceConfig)
            .build()

        Bridge.log("Nex: Sent display distance command => distance_cm (tier): $tier")

        return generateProtobufCommandBytes(phoneToGlasses)
    }

    fun generateBrightnessConfigCommandBytes(brightness: Int): ByteArray {
        // Validate brightness range
        val validBrightness = if (brightness != -1) {
            (brightness * 63) / 100
        } else {
            (30 * 63) / 100 // Default to 30% if brightness is -1
        }

        Bridge.log("Nex: === SENDING BRIGHTNESS COMMAND TO GLASSES ===")
        Bridge.log("Nex: Brightness Value: $brightness (validated: $validBrightness)")

        val brightnessConfig = BrightnessConfig.newBuilder()
            .setValue(validBrightness)
            .build()

        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setBrightness(brightnessConfig)
            .build()

        Bridge.log("Nex: Sent auto light brightness command => Brightness: $validBrightness")

        return generateProtobufCommandBytes(phoneToGlasses)
    }

    fun generateMicStateConfigCommandBytes(enable: Boolean): ByteArray {
        Bridge.log("Nex: Microphone Enabled: $enable")
        val micStateConfig = MicStateConfig.newBuilder()
            .setEnabled(enable)
            .build()
        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setMicState(micStateConfig)
            .build()

        return generateProtobufCommandBytes(phoneToGlasses)
    }

    fun generateVadEnabledRequestCommandBytes(enable: Boolean): ByteArray {
        Bridge.log("Nex: VAD Enabled: $enable")
        val vadEnabledConfig = VadEnabledConfig.newBuilder()
            .setEnabled(enable)
            .build()
        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setVadEnabled(vadEnabledConfig)
            .build()

        return generateProtobufCommandBytes(phoneToGlasses)
    }

    fun generateAutoBrightnessConfigCommandBytes(autoLight: Boolean): ByteArray {
        Bridge.log("Nex: === SENDING AUTO BRIGHTNESS COMMAND TO GLASSES ===")
        Bridge.log("Nex: Auto Brightness Enabled: $autoLight")

        val autoBrightnessConfig = AutoBrightnessConfig.newBuilder()
            .setEnabled(autoLight)
            .build()

        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setAutoBrightness(autoBrightnessConfig)
            .build()

        Bridge.log("Nex: Sent auto light sendAutoBrightnessCommand => $autoLight")

        return generateProtobufCommandBytes(phoneToGlasses)
    }

    private fun createWhitelistJson(apps: List<AppInfo>): String {
        return try {
            val appList = JSONArray().apply {
                apps.forEach { app ->
                    put(JSONObject().apply {
                        put("id", app.id)
                        put("name", app.name)
                    })
                }
            }

            JSONObject().apply {
                put("calendar_enable", false)
                put("call_enable", false)
                put("msg_enable", false)
                put("ios_mail_enable", false)
                put("app", JSONObject().apply {
                    put("list", appList)
                    put("enable", true)
                })
            }.toString()
        } catch (e: JSONException) {
            Log.e(TAG, "Error creating whitelist JSON: ${e.message}", e)
            "{}"
        }
    }

    private fun createWhitelistChunks(json: String, maxChunkSize: Int): List<ByteArray> {
        val jsonBytes = json.toByteArray(Charsets.UTF_8)
        val totalChunks = (jsonBytes.size + maxChunkSize - 1) / maxChunkSize

        return List(totalChunks) { chunkIndex ->
            val start = chunkIndex * maxChunkSize
            val end = (start + maxChunkSize).coerceAtMost(jsonBytes.size)
            val payloadChunk = jsonBytes.copyOfRange(start, end)

            // Create the header: [WHITELIST_CMD, total_chunks, chunk_index]
            val header = byteArrayOf(
                WHITELIST_CMD.toByte(),
                totalChunks.toByte(),
                chunkIndex.toByte()
            )

            header + payloadChunk
        }
    }

    /**
     * Returns the raw serialized PhoneToGlasses protobuf bytes.
     *
     * Transport framing (the 0x02 packet type and the [seq][totalChunks][chunkIndex]
     * fragmentation header) is applied at send time by MentraNexSGC.sendProtobuf(),
     * which owns the negotiated MTU / chunk size. Keeping framing out of here lets a
     * single chunker handle every control command uniformly.
     */
    private fun generateProtobufCommandBytes(phoneToGlasses: PhoneToGlasses): ByteArray {
        val contentBytes = phoneToGlasses.toByteArray()
        logProtobufMessage(phoneToGlasses, contentBytes)
        return contentBytes
    }

    private fun logProtobufMessage(phoneToGlasses: PhoneToGlasses, fullMessage: ByteArray) {
        val logMessage = buildString {
            appendLine("=== PROTOBUF MESSAGE TO GLASSES ===")
            appendLine("Message Type: ${phoneToGlasses.payloadCase}")

            // Extract and log text content if present
            when {
                phoneToGlasses.hasDisplayText() -> {
                    val text = phoneToGlasses.displayText.text
                    appendLine("Text Content: \"$text\"")
                    appendLine("Text Length: ${text.length} characters")
                }
                phoneToGlasses.hasDisplayScrollingText() -> {
                    val text = phoneToGlasses.displayScrollingText.text
                    appendLine("Scrolling Text Content: \"$text\"")
                    appendLine("Text Length: ${text.length} characters")
                }
            }

            // Log message size information
            appendLine("Protobuf Payload Size: ${phoneToGlasses.toByteArray().size} bytes")
            appendLine("Total Message Size: ${fullMessage.size} bytes")
            appendLine("Packet Type: 0x${NexBluetoothPacketTypes.PACKET_TYPE_PROTOBUF.toString(16).padStart(2, '0').uppercase()}")
            append("=====================================")
        }

        Bridge.log("Nex: $logMessage")
    }

    private fun readProtoVersionFromAssets(context: Context): String? {
        return try {
            context.assets.open("mentraos_ble.proto").use { inputStream ->
                val content = inputStream.bufferedReader().use { it.readText() }
                extractVersionFromProtoContent(content)
            }
        } catch (e: IOException) {
            Bridge.log("Could not read proto from assets: ${e.message}")
            null
        }
    }

    private fun readProtoVersionFromResources(context: Context): String? {
        return try {
            val resId = context.resources.getIdentifier("mentraos_ble", "raw", context.packageName)
            if (resId != 0) {
                context.resources.openRawResource(resId).use { inputStream ->
                    val content = inputStream.bufferedReader().use { it.readText() }
                    extractVersionFromProtoContent(content)
                }
            } else {
                null
            }
        } catch (e: Exception) {
            Bridge.log("Could not read proto from resources: ${e.message}")
            null
        }
    }

    private fun readProtoVersionFromProject(context: Context): String? {
        val projectPaths = arrayOf(
            "../../mcu_client/mentraos_ble.proto",
            "../../../mcu_client/mentraos_ble.proto",
            "../../../../mcu_client/mentraos_ble.proto",
            "/data/data/${context.packageName}/../../mcu_client/mentraos_ble.proto",
            "${android.os.Environment.getExternalStorageDirectory()}/MentraOS/mcu_client/mentraos_ble.proto"
        )

        return projectPaths.firstNotNullOfOrNull { path ->
            try {
                val protoFile = java.io.File(path)
                if (protoFile.exists() && protoFile.canRead()) {
                    val content = protoFile.readText(Charsets.UTF_8)
                    extractVersionFromProtoContent(content)
                } else {
                    null
                }
            } catch (e: Exception) {
                null
            }
        }
    }

    private fun extractVersionFromProtoContent(content: String): String? {
        return try {
            val pattern = Regex("""option\s*\(\s*mentra_schema_version\s*\)\s*=\s*(\d+)\s*;""")
            pattern.find(content)?.groupValues?.get(1)
        } catch (e: Exception) {
            Log.e(TAG, "Error extracting version from proto content: ${e.message}", e)
            null
        }
    }
}

object NexEventUtils {
    private const val TAG = "NexEventUtils"
    
    fun sendHeartbeatSentEvent(timestamp: Long) {
        try {
            val data = HashMap<String, Any>()
            data["timestamp"] = timestamp

            Bridge.sendTypedMessage("heartbeat_sent", data as Map<String, Any>)
            Bridge.log("NOTIF: Successfully queued heartbeat sent event")
        } catch (e: Exception) {
            Log.e(TAG, "NOTIF: Error sending heartbeat sent event", e)
        }
    }

    fun sendHeartbeatReceivedEvent(timestamp: Long) {
        try {
            val data = HashMap<String, Any>()
            data["timestamp"] = timestamp

            Bridge.sendTypedMessage("heartbeat_received", data as Map<String, Any>)
            Bridge.log("NOTIF: Successfully queued heartbeat received event")
        } catch (e: Exception) {
            Log.e(TAG, "NOTIF: Error sending heartbeat received event", e)
        }
    }

    fun sendBleCommandSentEvent(payloadCase: String, packetHex: String, timestamp: Long) {
        try {
            val data = HashMap<String, Any>()
            data["command"] = payloadCase
            data["commandText"] = packetHex
            data["timestamp"] = timestamp

            Bridge.sendTypedMessage("send_command_to_ble", data as Map<String, Any>)
            Bridge.log("NOTIF: Successfully queued ble command sent event")
        } catch (e: Exception) {
            Log.e(TAG, "NOTIF: Error sending ble command sent event", e)
        }
    }

    fun sendBleCommandReceivedEvent(payloadCase: String, packetHex: String, timestamp: Long) {
        try {
            val data = HashMap<String, Any>()
            data["command"] = payloadCase
            data["commandText"] = packetHex
            data["timestamp"] = timestamp

            Bridge.sendTypedMessage("receive_command_from_ble", data as Map<String, Any>)
            Bridge.log("NOTIF: Successfully queued ble command received event")
        } catch (e: Exception) {
            Log.e(TAG, "NOTIF: Error sending ble command received event", e)
        }
    }
}