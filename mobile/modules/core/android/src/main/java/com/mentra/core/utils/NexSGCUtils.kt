package com.mentra.core.utils

import java.nio.ByteBuffer
import java.io.IOException
import java.util.UUID

import android.content.Context
import android.util.Log

import com.mentra.core.Bridge

import mentraos.ble.MentraosBle.DisplayText
import mentraos.ble.MentraosBle.ClearDisplay
import mentraos.ble.MentraosBle.PhoneToGlasses
import mentraos.ble.MentraosBle.DisplayImage
import mentraos.ble.MentraosBle.PongResponse
import mentraos.ble.MentraosBle.BatteryStateRequest
import mentraos.ble.MentraosBle.MicStateConfig
import mentraos.ble.MentraosBle.BrightnessConfig
import mentraos.ble.MentraosBle.AutoBrightnessConfig
import mentraos.ble.MentraosBle.HeadUpAngleConfig
import mentraos.ble.MentraosBle.DisplayHeightConfig
import mentraos.ble.MentraosBle.VersionRequest

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

    fun constructPongResponse(): ByteArray {
        Bridge.log("Nex: Constructing pong response to glasses ping")
        
        // Create the PongResponse message
        val pongResponse = PongResponse.newBuilder().build()
        // Create the PhoneToGlasses message with the pong response
        val phoneToGlasses = PhoneToGlasses.newBuilder().setPong(pongResponse).build()
        return generateProtobufCommandBytes(phoneToGlasses)
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
            .setMsgId("clear_disp_001")
            .setClearDisplay(clearDisplay)
            .build();
        return generateProtobufCommandBytes(phoneToGlasses);
    }

    fun generateVersionRequestCommandBytes(): ByteArray {
        val msgId = "ver_req_${System.currentTimeMillis()}"
        val versionRequest = VersionRequest.newBuilder()
            .setMsgId(msgId)
            .build()
        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setMsgId(msgId)
            .setVersionRequest(versionRequest)
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

    fun generateDisplayTextCommandBytes(text: String): ByteArray {
        Bridge.log("Nex: === SENDING TEXT TO GLASSES ===")
        Bridge.log("Nex: Text: \"$text\"")
        Bridge.log("Nex: Text Length: ${text.length} characters")

        // Replace all m-dashes with normal dash
        val textWithNormalDash = text.replace("—", "-")

        val textNewBuilder = DisplayText.newBuilder()
            .setColor(10000)
            .setText(textWithNormalDash)
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

    fun generateDisplayHeightCommandBytes(height: Int, depth: Int): ByteArray {
        // clamp height to 0-8 and depth to 1-9
        val clampedHeight = height.coerceIn(0, 8)
        val clampedDepth = depth.coerceIn(1, 9)

        Bridge.log("Nex: === SENDING DASHBOARD POSITION COMMAND TO GLASSES ===")
        Bridge.log("Nex: Dashboard Position - Height: $clampedHeight (0-8), Depth: $clampedDepth (1-9)")
        val displayHeightConfig = DisplayHeightConfig.newBuilder()
            .setHeight(clampedHeight)
            .build()
        
        val phoneToGlasses = PhoneToGlasses.newBuilder()
            .setDisplayHeight(displayHeightConfig)
            .build()
        
        Bridge.log("Nex: Sent dashboard height/depth command => Height: $clampedHeight, Depth: $clampedDepth")
        
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

    private fun generateProtobufCommandBytes(phoneToGlasses: PhoneToGlasses): ByteArray {
        val contentBytes = phoneToGlasses.toByteArray()
        val chunk = ByteBuffer.allocate(contentBytes.size + 1)

        chunk.put(NexBluetoothPacketTypes.PACKET_TYPE_PROTOBUF)
        chunk.put(contentBytes)

        // Enhanced logging for protobuf messages
        val result = chunk.array()
        logProtobufMessage(phoneToGlasses, result)

        return result
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