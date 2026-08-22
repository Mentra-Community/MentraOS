//
//  Bridge.kt
//  AOS
//
//  Created by Matthew Fosse on 3/4/25.
//

package com.mentra.bluetoothsdk

import android.util.Base64
import android.util.Log
import com.mentra.bluetoothsdk.debug.BleTraceLogger
import java.util.HashMap
import java.util.UUID
import kotlin.jvm.JvmStatic
import kotlin.jvm.Synchronized
import kotlin.jvm.Volatile

/**
 * Bridge class for SDK communication between Expo modules and native Android code This is the
 * Android equivalent of the iOS Bridge.swift
 */
public class Bridge private constructor() {
    private var deviceManager: DeviceManager? = null

    companion object {
        private const val TAG = "Bridge"
        private const val MIC_SAMPLE_RATE = 16_000
        private const val PCM_BITS_PER_SAMPLE = 16
        private const val MIC_CHANNELS = 1
        private const val LC3_FRAME_DURATION_MS = 10
        private const val DEFAULT_LC3_FRAME_SIZE_BYTES = 60
        private val AUDIO_TRACE_METADATA_KEYS =
                listOf(
                        "sampleRate",
                        "bitsPerSample",
                        "channels",
                        "encoding",
                        "frameDurationMs",
                        "frameSizeBytes",
                        "bitrate",
                        "packetizedFromGlasses",
                        "voiceActivityDetectionEnabled",
                )

        @Volatile private var instance: Bridge? = null

        private const val DEFAULT_EVENT_SINK_ID = "default"

        // Event sinks for JS and native consumers.
        private val eventSinks = linkedMapOf<String, (String, Map<String, Any>) -> Unit>()

        // Android Context for native operations
        private var appContext: android.content.Context? = null

        @JvmStatic
        @Synchronized
        fun getInstance(): Bridge {
            if (instance == null) {
                instance = Bridge()
            }
            return instance!!
        }

        /**
         * Initialize the Bridge with event callback and context This should be called from
         * BluetoothSdkModule
         */
        @JvmStatic
        fun initialize(
                context: android.content.Context,
                callback: (String, Map<String, Any>) -> Unit
        ) {
            Log.d(TAG, "Initializing Bridge with context and event callback")
            initialize(context)
            setEventSink(DEFAULT_EVENT_SINK_ID, callback)
        }

        @JvmStatic
        fun initialize(context: android.content.Context) {
            appContext = context
        }

        @JvmStatic
        @Synchronized
        fun addEventSink(callback: (String, Map<String, Any>) -> Unit): String {
            val id = UUID.randomUUID().toString()
            setEventSink(id, callback)
            return id
        }

        @JvmStatic
        @Synchronized
        fun removeEventSink(id: String) {
            eventSinks.remove(id)
        }

        @Synchronized
        private fun setEventSink(id: String, callback: (String, Map<String, Any>) -> Unit) {
            eventSinks[id] = callback
        }

        @Synchronized
        private fun getEventSinks(): List<(String, Map<String, Any>) -> Unit> {
            return eventSinks.values.toList()
        }

        /** Get the Android context for native operations */
        @JvmStatic
        fun getContext(): android.content.Context {
            return appContext ?: throw IllegalStateException("Bridge not initialized with context")
        }

        /** Log a message and send it to JavaScript */
        @JvmStatic
        fun log(message: String) {
            val data = HashMap<String, Any>()
            data["message"] = message
            sendTypedMessage("log", data as Map<String, Any>)
        }

        /** Report tar.bz2 extraction progress to JavaScript. */
        @JvmStatic
        fun sendExtractionProgress(percentage: Int, bytesRead: Long, totalBytes: Long) {
            val data = HashMap<String, Any>()
            data["percentage"] = percentage
            data["bytesRead"] = bytesRead
            data["totalBytes"] = totalBytes
            sendTypedMessage("extraction_progress", data as Map<String, Any>)
        }

        /** Send head position event */
        @JvmStatic
        fun sendHeadUp(isUp: Boolean) {
            val data = HashMap<String, Any>()
            data["up"] = isUp
            sendTypedMessage("head_up", data as Map<String, Any>)
        }

        /** Send pair failure event */
        @JvmStatic
        fun sendPairFailureEvent(error: String) {
            val data = HashMap<String, Any>()
            data["error"] = error
            sendTypedMessage("pair_failure", data as Map<String, Any>)
        }

        /** Send audio connected event - matches iOS implementation for platform parity */
        @JvmStatic
        fun sendAudioConnected(deviceName: String) {
            val data = HashMap<String, Any>()
            data["deviceName"] = deviceName
            sendTypedMessage("audio_connected", data as Map<String, Any>)
        }

        /** Send audio disconnected event - matches iOS implementation for platform parity */
        @JvmStatic
        fun sendAudioDisconnected() {
            val data = HashMap<String, Any>()
            sendTypedMessage("audio_disconnected", data as Map<String, Any>)
        }

        @JvmStatic
        fun sendMicPcm(data: ByteArray) {
            val body = micPcmEventBody(data)
            sendTypedMessage("mic_pcm", body as Map<String, Any>)
        }
        
        @JvmStatic
        fun sendMicLc3(data: ByteArray) {
            val body = micLc3EventBody(data)
            sendTypedMessage("mic_lc3", body as Map<String, Any>)
        }

        private fun micPcmEventBody(data: ByteArray): HashMap<String, Any> {
            val voiceActivityDetectionEnabled =
                    DeviceStore.get("glasses", "voiceActivityDetectionEnabled") as? Boolean
                            ?: BluetoothSdkDefaults.VOICE_ACTIVITY_DETECTION_ENABLED
            val body = HashMap<String, Any>()
            body["pcm"] = data
            body["sampleRate"] = MIC_SAMPLE_RATE
            body["bitsPerSample"] = PCM_BITS_PER_SAMPLE
            body["channels"] = MIC_CHANNELS
            body["encoding"] = "pcm_s16le"
            body["voiceActivityDetectionEnabled"] = voiceActivityDetectionEnabled
            return body
        }

        private fun micLc3EventBody(data: ByteArray): HashMap<String, Any> {
            val voiceActivityDetectionEnabled =
                    DeviceStore.get("glasses", "voiceActivityDetectionEnabled") as? Boolean
                            ?: BluetoothSdkDefaults.VOICE_ACTIVITY_DETECTION_ENABLED
            val frameSizeBytes =
                    (DeviceStore.store.get("bluetooth", "lc3_frame_size") as? Number)?.toInt()
                            ?: DEFAULT_LC3_FRAME_SIZE_BYTES
            val body = HashMap<String, Any>()
            body["lc3"] = data
            body["sampleRate"] = MIC_SAMPLE_RATE
            body["channels"] = MIC_CHANNELS
            body["encoding"] = "lc3"
            body["frameDurationMs"] = LC3_FRAME_DURATION_MS
            body["frameSizeBytes"] = frameSizeBytes
            body["bitrate"] = frameSizeBytes * 8 * (1000 / LC3_FRAME_DURATION_MS)
            body["packetizedFromGlasses"] = false
            body["voiceActivityDetectionEnabled"] = voiceActivityDetectionEnabled
            return body
        }

        /** Save a setting */
        @JvmStatic
        fun saveSetting(key: String, value: Any) {
            val body = HashMap<String, Any>()
            body["key"] = key
            body["value"] = value
            sendTypedMessage("save_setting", body as Map<String, Any>)
        }

        /** Send Voice Activity Detection status */
        @JvmStatic
        fun sendVoiceActivityDetectionStatus(enabled: Boolean) {
            DeviceStore.set("glasses", "voiceActivityDetectionEnabled", enabled)
            val body = HashMap<String, Any>()
            body["voiceActivityDetectionEnabled"] = enabled
            sendTypedMessage("voice_activity_detection_status", body as Map<String, Any>)
        }

        /** Send live speaking status reported by glasses-side Voice Activity Detection. */
        @JvmStatic
        fun sendSpeakingStatus(speaking: Boolean) {
            val body = HashMap<String, Any>()
            body["speaking"] = speaking
            body["timestamp"] = System.currentTimeMillis()
            sendTypedMessage("speaking_status", body as Map<String, Any>)
        }

        /** Send battery status */
        @JvmStatic
        fun sendBatteryStatus(level: Int, charging: Boolean) {
            val body = HashMap<String, Any>()
            body["level"] = level
            body["charging"] = charging
            body["timestamp"] = System.currentTimeMillis()
            sendTypedMessage("battery_status", body as Map<String, Any>)
        }

        /** Send discovered device */
        @JvmStatic
        @JvmOverloads
        fun sendDiscoveredDevice(
                deviceModel: String,
                deviceName: String,
                deviceAddress: String = "",
                rssi: Int? = null,
                projectName: String? = null
        ) {
            val searchResults =
                    (DeviceStore.store.getCategory("bluetooth")["searchResults"] as? List<*>)
                            ?.mapNotNull { result ->
                                (result as? Map<*, *>)?.entries
                                        ?.mapNotNull { (key, value) ->
                                            if (key is String && value != null) key to value else null
                                        }
                                        ?.toMap()
                            }
                            ?: emptyList()
            val id = listOfNotNull(deviceModel, projectName?.takeIf { it.isNotBlank() }, deviceName).joinToString(":")
            val newResult =
                    buildMap<String, Any> {
                        put("id", id)
                        put("model", deviceModel)
                        put("name", deviceName)
                        if (deviceAddress.isNotBlank()) {
                            put("address", deviceAddress)
                        }
                        projectName?.takeIf { it.isNotBlank() }?.let { put("projectName", it) }
                        rssi?.let { put("rssi", it) }
                    }
            // Keep the public searchResults array stable as glasses are added or removed.
            // Duplicate discoveries refresh their existing row; only new glasses append.
            val uniqueResults = mergeStableSearchResults(searchResults, newResult, deviceModel)
            DeviceStore.set("bluetooth", "searchResults", uniqueResults)
        }

        private fun mergeStableSearchResults(
                currentResults: List<Map<String, Any>>,
                newResult: Map<String, Any>,
                fallbackModel: String
        ): List<Map<String, Any>> {
            val newKey = searchResultKey(newResult, fallbackModel) ?: return currentResults
            val nextResults = currentResults.toMutableList()
            val existingIndex =
                    nextResults.indexOfFirst { result ->
                        searchResultKey(result, fallbackModel) == newKey
                    }
            if (existingIndex >= 0) {
                nextResults[existingIndex] = newResult
            } else {
                nextResults += newResult
            }
            return nextResults
        }

        private fun searchResultKey(result: Map<String, Any>, fallbackModel: String): String? {
            val id = result["id"] as? String
            if (!id.isNullOrBlank()) {
                return id
            }
            val model = result["model"] as? String ?: fallbackModel
            val name = result["name"] as? String ?: return null
            return "$model:$name"
        }

        // MARK: - Hardware Events

        /** Send button press event to React Native - matches iOS implementation */
        @JvmStatic
        fun sendButtonPressEvent(buttonId: String, pressType: String) {
            val buttonData = HashMap<String, Any>()
            buttonData["buttonId"] = buttonId
            buttonData["pressType"] = pressType
            buttonData["timestamp"] = System.currentTimeMillis()

            sendTypedMessage("button_press", buttonData as Map<String, Any>)
        }

        /** Send miniapp selection event from glasses dashboard menu */
        @JvmStatic
        fun sendMiniappSelected(packageName: String) {
            val body = HashMap<String, Any>()
            body["packageName"] = packageName
            sendTypedMessage("miniapp_selected", body)
        }

        /** Send touch/gesture event from glasses - matches iOS implementation */
        @JvmStatic
        @JvmOverloads
        fun sendTouchEvent(
                deviceModel: String,
                gestureName: String,
                timestamp: Long,
                source: Int? = null
        ) {
            val body = HashMap<String, Any>()
            body["type"] = "touch_event"
            body["deviceModel"] = deviceModel
            body["gestureName"] = gestureName
            body["timestamp"] = timestamp
            if (source != null) {
                body["source"] = source
            }
            sendTypedMessage("touch_event", body)
        }

        /** Send swipe volume control status - matches iOS implementation */
        @JvmStatic
        fun sendSwipeVolumeStatus(enabled: Boolean, timestamp: Long) {
            val body = HashMap<String, Any>()
            body["enabled"] = enabled
            body["timestamp"] = timestamp
            sendTypedMessage("swipe_volume_status", body)
        }

        /** Send switch status from glasses - matches iOS implementation */
        @JvmStatic
        fun sendSwitchStatus(switchType: Int, value: Int, timestamp: Long) {
            val body = HashMap<String, Any>()
            body["switchType"] = switchType
            body["switchValue"] = value
            body["timestamp"] = timestamp
            sendTypedMessage("switch_status", body)
        }

        @JvmStatic
        fun sendPhotoError(requestId: String, errorCode: String, errorMessage: String) {
            val timestamp = System.currentTimeMillis()
            val event = HashMap<String, Any>()
            event["type"] = "photo_response"
            event["state"] = "error"
            event["requestId"] = requestId
            event["errorCode"] = errorCode
            event["errorMessage"] = errorMessage
            event["timestamp"] = timestamp
            sendTypedMessage("photo_response", event as Map<String, Any>)
        }

        @JvmStatic
        fun sendPhotoStatus(statusJson: Map<String, Any>) {
            sendTypedMessage("photo_status", statusJson)
        }

        @JvmStatic
        fun sendCameraStatus(statusJson: Map<String, Any>) {
            sendTypedMessage("camera_status", statusJson)
        }

        @JvmStatic
        fun sendPhotoResponse(responseJson: Map<String, Any>) {
            sendTypedMessage("photo_response", responseJson)
        }

        /** Send RGB LED control response */
        @JvmStatic
        fun sendRgbLedControlResponse(requestId: String, success: Boolean, error: String?) {
            if (requestId.isEmpty()) return
            try {
                val body = HashMap<String, Any>()
                body["type"] = "rgb_led_control_response"
                body["requestId"] = requestId
                body["state"] = if (success) "success" else "error"
                if (!success) {
                    body["errorCode"] = error ?: "unknown_error"
                }
                sendTypedMessage("rgb_led_control_response", body)
            } catch (e: Exception) {
                log("Bridge: Error sending rgb_led_control_response: $e")
            }
        }

        @JvmStatic
        fun sendSettingsAck(values: Map<String, Any>) {
            val body = HashMap<String, Any>()
            body["type"] = "settings_ack"
            values.forEach { (key, value) ->
                body[key] = value
            }
            sendTypedMessage("settings_ack", body)
        }

        @JvmStatic
        fun sendVideoRecordingStatus(values: Map<String, Any>) {
            val body = HashMap<String, Any>()
            body["type"] = "video_recording_status"
            values.forEach { (key, value) ->
                body[key] = value
            }
            sendTypedMessage("video_recording_status", body)
        }

        @JvmStatic
        fun sendMediaUploadEvent(type: String, values: Map<String, Any>) {
            val body = HashMap<String, Any>()
            body["type"] = type
            values.forEach { (key, value) ->
                body[key] = value
            }
            sendTypedMessage(type, body)
        }

        @JvmStatic
        fun sendVersionInfo(values: Map<String, Any>) {
            fun stringField(vararg keys: String): String =
                    keys.firstNotNullOfOrNull { key -> values[key] as? String } ?: ""
            val body = HashMap<String, Any>()
            body["type"] = "version_info"
            body["androidVersion"] = stringField("androidVersion", "android_version")
            body["firmwareVersion"] = stringField("firmwareVersion", "firmware_version")
            body["besFirmwareVersion"] = stringField("besFirmwareVersion", "bes_fw_version")
            body["mtkFirmwareVersion"] = stringField("mtkFirmwareVersion", "mtk_fw_version")
            body["buildNumber"] = stringField("buildNumber", "build_number")
            (values["systemTimeMs"] as? Number ?: values["system_time_ms"] as? Number)?.let {
                body["systemTimeMs"] = it.toLong()
            }
            body["otaVersionUrl"] = stringField("otaVersionUrl", "ota_version_url")
            body["appVersion"] = stringField("appVersion", "app_version")
            (values["hotspotOtaVersion"] as? Number
                            ?: values["hotspot_ota_version"] as? Number)
                    ?.let { body["hotspotOtaVersion"] = it.toInt() }
            sendTypedMessage("version_info", body)
        }

        /**
         * Send transcription result to server Used by AOSManager to send pre-formatted
         * transcription results Matches the Swift structure exactly
         */
        @JvmStatic
        fun sendLocalTranscription(transcription: Map<String, Any>) {
            val text = transcription["text"] as? String
            if (text == null || text.isEmpty()) {
                log("Skipping empty transcription result")
                return
            }

            sendTypedMessage("local_transcription", transcription)
        }

        /** Convenience method for sending local transcription from transcriber */
        @JvmStatic
        fun sendLocalTranscription(text: String, isFinal: Boolean, language: String) {
            if (text.isEmpty()) {
                log("Skipping empty transcription result")
                return
            }

            val transcription =
                    mapOf(
                            "text" to text,
                            "isFinal" to isFinal,
                            "language" to language,
                            "type" to "local_transcription"
                    )

            sendTypedMessage("local_transcription", transcription)
        }

        // Bluetooth SDK bridge funcs:

        /** Send status update */
        @JvmStatic
        fun sendStatus(statusObj: Map<String, Any>) {
            val body = HashMap<String, Any>()
            body["bluetooth_status"] = statusObj
            sendTypedMessage("bluetooth_status_update", body as Map<String, Any>)
        }

        /** Send glasses serial number */
        @JvmStatic
        fun sendserialNumber(serialNumber: String, style: String, color: String) {
            val serialData = HashMap<String, Any>()
            serialData["serial_number"] = serialNumber
            serialData["style"] = style
            serialData["color"] = color

            val body = HashMap<String, Any>()
            body["glasses_serial_number"] = serialData
            sendTypedMessage("glasses_serial_number", body as Map<String, Any>)
        }

        /**
         * Send WiFi status change. [error] is the glasses' provisioning failure reason
         * (e.g. "connect_timeout", "connected_to_other_network") when this status is the
         * verdict of a failed connect attempt; null for routine link-state updates.
         */
        @JvmStatic
        @JvmOverloads
        fun sendWifiStatusChange(
                connected: Boolean,
                ssid: String?,
                localIp: String?,
                error: String? = null
        ) {
            val status = WifiStatus.fromStoreFields(connected, ssid, localIp) ?: return
            val payload =
                    if (error != null) status.toMap() + mapOf("error" to error)
                    else status.toMap()
            sendTypedMessage("wifi_status_change", payload)
        }

        /**
         * Claim the WiFi scan-results store for a newly requested scan. Called by the
         * SDK when it generates the scanId, BEFORE the scan command goes out: store
         * ownership is decided at request time, not by whichever chunk arrives first,
         * so a delayed chunk from an older, abandoned scan can never reset or clobber
         * the current scan's accumulator.
         */
        @JvmStatic
        fun claimWifiScanResults(scanId: String) {
            DeviceStore.apply("bluetooth", "wifiScanActiveScanId", scanId)
        }

        /** Send WiFi scan results */
        @JvmStatic
        fun updateWifiScanResults(
                networks: List<Map<String, Any>>,
                scanComplete: Boolean,
                scanId: String? = null
        ) {
            // Only chunks echoing the active scanId claimed at request time may mutate
            // the store; foreign chunks are still forwarded to the SDK sink, which
            // drops stale ids itself. Scan-id-less chunks (old firmware) keep the
            // legacy accumulate-forever store behavior.
            val ownsStore =
                    scanId == null || scanId == DeviceStore.get("bluetooth", "wifiScanActiveScanId")
            var updatedNetworks: List<Map<String, Any>> = networks
            if (ownsStore) {
                var storedNetworks: List<Map<String, Any>> =
                        DeviceStore.get("bluetooth", "wifiScanResults") as? List<Map<String, Any>>
                                ?: emptyList()
                val lastScanId = DeviceStore.get("bluetooth", "wifiScanResultsScanId")
                if (scanId != null && scanId != lastScanId) {
                    // First chunk of a new scan: drop networks accumulated for a previous scan
                    // so stale entries never carry over into this scan's store.
                    storedNetworks = emptyList()
                    DeviceStore.apply("bluetooth", "wifiScanResultsScanId", scanId)
                }
                // add the networks to the storedNetworks array, removing duplicates by ssid
                val merged = storedNetworks.toMutableList()
                for (network in networks) {
                    if (!merged.any { it["ssid"] as? String == network["ssid"] as? String }) {
                        merged.add(network)
                    }
                }
                DeviceStore.apply("bluetooth", "wifiScanResults", merged)
                updatedNetworks = merged
            }
            val body = HashMap<String, Any>()
            // Correlated scans: the SDK accumulates and dedupes chunks per scanId itself,
            // so forward only this chunk; the merged store list is for UI consumers.
            body["networks"] = if (scanId != null) networks else updatedNetworks
            body["scanComplete"] = scanComplete
            if (scanId != null) {
                body["scanId"] = scanId
            }
            sendTypedMessage("wifi_scan_result", body)
        }

        /** Send gallery status - matches iOS MentraLive.swift handleGalleryStatus pattern */
        @JvmStatic
        fun sendGalleryStatus(
                photoCount: Int,
                videoCount: Int,
                totalCount: Int,
                totalSize: Long,
                hasContent: Boolean,
                cameraBusy: Boolean,
                cameraBusyReason: String?
        ) {
            val galleryData = HashMap<String, Any>()
            galleryData["type"] = "gallery_status"
            galleryData["photos"] = photoCount
            galleryData["videos"] = videoCount
            galleryData["total"] = totalCount
            galleryData["totalSize"] = totalSize
            galleryData["hasContent"] = hasContent
            galleryData["cameraBusy"] = cameraBusy
            if (!cameraBusyReason.isNullOrBlank()) {
                galleryData["cameraBusyReason"] = cameraBusyReason
            }

            sendTypedMessage("gallery_status", galleryData as Map<String, Any>)
        }

        /** Send hotspot status change - matches iOS MentraLive.swift emitHotspotStatusChange */
        @JvmStatic
        fun sendHotspotStatusChange(
                enabled: Boolean,
                ssid: String,
                password: String,
                gatewayIp: String
        ) {
            val status = HotspotStatus.fromStoreFields(enabled, ssid, password, gatewayIp) ?: return
            sendTypedMessage("hotspot_status_change", status.toMap())
        }

        /** Send hotspot error - notifies React Native of hotspot failures */
        @JvmStatic
        fun sendHotspotError(errorMessage: String, timestamp: Long) {
            val eventBody = HashMap<String, Any>()
            eventBody["errorMessage"] = errorMessage
            eventBody["timestamp"] = timestamp

            sendTypedMessage("hotspot_error", eventBody as Map<String, Any>)
        }

        /** Send MTK firmware update complete notification - matches iOS implementation */
        @JvmStatic
        fun sendMtkUpdateComplete(message: String) {
            val eventBody = HashMap<String, Any>()
            eventBody["message"] = message
            eventBody["timestamp"] = System.currentTimeMillis()
            sendTypedMessage("mtk_update_complete", eventBody as Map<String, Any>)
        }

        /** Send ota_start_ack — glasses confirmed receipt of ota_start command */
        @JvmStatic
        fun sendOtaStartAck() {
            val eventBody = HashMap<String, Any>()
            eventBody["timestamp"] = System.currentTimeMillis()
            sendTypedMessage("ota_start_ack", eventBody as Map<String, Any>)
        }

        @JvmStatic
        @JvmOverloads
        fun sendOtaStatus(
                sessionId: String,
                totalSteps: Int,
                currentStep: Int,
                stepType: String,
                phase: String,
                stepPercent: Int,
                overallPercent: Int,
                status: String,
                errorMessage: String? = null,
                glassesTimeMs: Long? = null,
        ) {
            val eventBody = HashMap<String, Any>()
            eventBody["session_id"] = sessionId
            eventBody["total_steps"] = totalSteps
            eventBody["current_step"] = currentStep
            eventBody["step_type"] = stepType
            eventBody["phase"] = phase
            eventBody["step_percent"] = stepPercent
            eventBody["overall_percent"] = overallPercent
            eventBody["status"] = status
            errorMessage?.let { eventBody["error_message"] = it }
            if (glassesTimeMs != null && glassesTimeMs > 0) {
                eventBody["glasses_time_ms"] = glassesTimeMs
            }

            Log.d(TAG, "Bridge: sendOtaStatus: $eventBody")

            sendTypedMessage("ota_status", eventBody as Map<String, Any>)
        }

        /** Send stream status - forwards to websocket system (matches iOS) */
        @JvmStatic
        fun sendStreamStatus(statusJson: Map<String, Any>) {
            sendTypedMessage("stream_status", statusJson)
        }

        /** Send keep alive ACK - forwards to websocket system (matches iOS) */
        @JvmStatic
        fun sendKeepAliveAck(ackJson: Map<String, Any>) {
            sendTypedMessage("keep_alive_ack", ackJson)
        }

        /** Send IMU data event - matches iOS MentraLive.swift emitImuDataEvent */
        @JvmStatic
        fun sendImuDataEvent(
                accel: DoubleArray,
                gyro: DoubleArray,
                mag: DoubleArray,
                quat: DoubleArray,
                euler: DoubleArray,
                timestamp: Long
        ) {
            val eventBody = HashMap<String, Any>()
            eventBody["accel"] = accel.toList()
            eventBody["gyro"] = gyro.toList()
            eventBody["mag"] = mag.toList()
            eventBody["quat"] = quat.toList()
            eventBody["euler"] = euler.toList()
            eventBody["timestamp"] = timestamp

            sendTypedMessage("imu_data_event", eventBody as Map<String, Any>)
        }

        /** Send IMU gesture event - matches iOS MentraLive.swift emitImuGestureEvent */
        @JvmStatic
        fun sendImuGestureEvent(gesture: String, timestamp: Long) {
            val eventBody = HashMap<String, Any>()
            eventBody["gesture"] = gesture
            eventBody["timestamp"] = timestamp

            sendTypedMessage("imu_gesture_event", eventBody as Map<String, Any>)
        }

        /**
         * Send a single accelerometer reading from the glasses IMU - matches iOS
         * Bridge.sendAccelEvent. A richer combined IMU event (gyro + magnetometer) is future work.
         */
        @JvmStatic
        fun sendAccelEvent(x: Float, y: Float, z: Float, timestamp: Long) {
            val body = HashMap<String, Any>()
            body["x"] = x
            body["y"] = y
            body["z"] = z
            body["timestamp"] = timestamp
            sendTypedMessage("accel_event", body as Map<String, Any>)
        }

        // Arbitrary WS Comms (don't use these, make a dedicated function for your use case):

        /** Send WebSocket text message */
        @JvmStatic
        fun sendWSText(msg: String) {
            val data = HashMap<String, Any>()
            data["text"] = msg
            sendTypedMessage("ws_text", data as Map<String, Any>)
        }

        /** Send WebSocket binary message */
        @JvmStatic
        fun sendWSBinary(data: ByteArray) {
            val base64String = Base64.encodeToString(data, Base64.NO_WRAP)
            val body = HashMap<String, Any>()
            body["base64"] = base64String
            sendTypedMessage("ws_bin", body as Map<String, Any>)
        }

        /**
         * Send a typed message to JavaScript Don't call this function directly, instead make a
         * function above that calls this function
         */
        @JvmStatic
        fun sendTypedMessage(type: String, body: Map<String, Any>) {
            var mutableBody = body
            if (body !is HashMap) {
                mutableBody = HashMap(body)
            }
            (mutableBody as HashMap<String, Any>)["type"] = type

            try {
                val sinks = getEventSinks()
                if (sinks.isEmpty()) {
                    Log.w(
                            TAG,
                            "Cannot send typed message '$type': no event sinks registered (app may be killed/backgrounded)"
                    )
                    return
                }

                val tracePayload = tracePayloadForTypedMessage(type, mutableBody as Map<String, Any>)
                if (tracePayload != null) {
                    try {
                        BleTraceLogger.logMap(
                            "phone_to_app",
                            "sdk_event_dispatch",
                            type,
                            tracePayload,
                        )
                    } catch (e: Exception) {
                        Log.d(TAG, "BLE trace logging failed for typed message '$type'", e)
                    }
                }

                // Send directly using type as event name - no JSON serialization
                sinks.forEach { sink ->
                    try {
                        sink(type, mutableBody as Map<String, Any>)
                    } catch (e: Exception) {
                        Log.e(
                                TAG,
                                "Error invoking event sink for type '$type' (listener may be dead)",
                                e
                        )
                        // Don't rethrow - one dead listener should not break other consumers.
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error sending typed message of type '$type'", e)
            }
        }

        private fun tracePayloadForTypedMessage(
                type: String,
                body: Map<String, Any>
        ): Map<String, Any>? =
                when {
                    type == "log" -> null
                    isAudioPayloadEvent(type) -> audioTracePayload(type, body)
                    else -> body
                }

        private fun isAudioPayloadEvent(type: String): Boolean =
                type == "mic_pcm" || type == "mic_lc3"

        private fun audioTracePayload(type: String, body: Map<String, Any>): Map<String, Any> {
            val payload = HashMap<String, Any>()
            payload["type"] = type
            payload["timestamp"] = System.currentTimeMillis()
            payload["payloadOmitted"] = true
            payload["payloadOmittedReason"] = "audio"

            val audioBytes =
                    when (type) {
                        "mic_pcm" -> (body["pcm"] as? ByteArray)?.size
                        "mic_lc3" -> (body["lc3"] as? ByteArray)?.size
                        else -> null
                    }
            audioBytes?.let { payload["audioBytes"] = it }

            AUDIO_TRACE_METADATA_KEYS.forEach { key ->
                val value = body[key]
                if (value != null) {
                    payload[key] = value
                }
            }

            return payload
        }
    }

    init {
        deviceManager = DeviceManager.Companion.getInstance()
        if (deviceManager == null) {
            Log.e(TAG, "Failed to initialize DeviceManager in Bridge constructor")
        }
    }
}

