//
//  Bridge.kt
//  AOS
//
//  Created by Matthew Fosse on 3/4/25.
//

package com.mentra.core

import android.util.Base64
import android.util.Log
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
    private var deviceManager: CoreManager? = null

    companion object {
        private const val TAG = "Bridge"

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
         * CoreModule
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
            data["device_name"] = deviceName
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
            // val base64String = Base64.encodeToString(data, Base64.NO_WRAP)
            // val body = HashMap<String, Any>()
            // body["base64"] = base64String
            // sendTypedMessage("mic_pcm", body as Map<String, Any>)
            val body = HashMap<String, Any>()
            body["pcm"] = data
            sendTypedMessage("mic_pcm", body as Map<String, Any>)
        }
        
        @JvmStatic
        fun sendMicLc3(data: ByteArray) {
            // val base64String = Base64.encodeToString(data, Base64.NO_WRAP)
            // val body = HashMap<String, Any>()
            // body["base64"] = base64String
            // sendTypedMessage("mic_lc3", body as Map<String, Any>)
            val body = HashMap<String, Any>()
            body["lc3"] = data
            sendTypedMessage("mic_lc3", body as Map<String, Any>)
        }

        /** Save a setting */
        @JvmStatic
        fun saveSetting(key: String, value: Any) {
            val body = HashMap<String, Any>()
            body["key"] = key
            body["value"] = value
            sendTypedMessage("save_setting", body as Map<String, Any>)
        }

        /** Send VAD (Voice Activity Detection) status */
        @JvmStatic
        fun sendVadEvent(isSpeaking: Boolean) {
            val body = HashMap<String, Any>()
            body["status"] = isSpeaking
            sendTypedMessage("vad_status", body as Map<String, Any>)
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
        fun sendDiscoveredDevice(deviceModel: String, deviceName: String) {
            val searchResults =
                    GlassesStore.store.getCategory("core")["searchResults"] as?
                            List<Map<String, String>>
                            ?: emptyList()
            val newResult = mapOf("deviceModel" to deviceModel, "deviceName" to deviceName)
            val allResults = searchResults + newResult
            val uniqueResults = allResults.associateBy { it["deviceName"] }.values.toList()
            GlassesStore.set("core", "searchResults", uniqueResults)
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
            body["device_model"] = deviceModel
            body["gesture_name"] = gestureName
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
            body["switch_type"] = switchType
            body["switch_value"] = value
            body["timestamp"] = timestamp
            sendTypedMessage("switch_status", body)
        }

        @JvmStatic
        fun sendPhotoError(requestId: String, errorCode: String, errorMessage: String) {
            val event = HashMap<String, Any>()
            event["type"] = "photo_response"
            event["requestId"] = requestId
            event["photoUrl"] = ""
            event["success"] = false
            event["errorCode"] = errorCode
            event["errorMessage"] = errorMessage
            event["timestamp"] = System.currentTimeMillis()
            sendTypedMessage("photo_response", event as Map<String, Any>)
        }

        /** Send RGB LED control response */
        @JvmStatic
        fun sendRgbLedControlResponse(requestId: String, success: Boolean, error: String?) {
            if (requestId.isEmpty()) return
            try {
                val body = HashMap<String, Any>()
                body["requestId"] = requestId
                body["success"] = success
                error?.let { body["error"] = it }
                sendTypedMessage("rgb_led_control_response", body)
            } catch (e: Exception) {
                log("Bridge: Error sending rgb_led_control_response: $e")
            }
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
            body["core_status"] = statusObj
            sendTypedMessage("core_status_update", body as Map<String, Any>)
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

        /** Send WiFi status change */
        @JvmStatic
        fun sendWifiStatusChange(connected: Boolean, ssid: String?, localIp: String?) {
            val event = HashMap<String, Any?>()
            event["connected"] = connected
            event["ssid"] = ssid
            event["local_ip"] = localIp
            sendTypedMessage("wifi_status_change", event as Map<String, Any>)
        }

        /** Send WiFi scan results */
        @JvmStatic
        fun updateWifiScanResults(networks: List<Map<String, Any>>) {
            var storedNetworks: List<Map<String, Any>> =
                    GlassesStore.get("core", "wifiScanResults") as? List<Map<String, Any>>
                            ?: emptyList()
            // add the networks to the storedNetworks array, removing duplicates by ssid
            val updatedNetworks = storedNetworks.toMutableList()
            for (network in networks) {
                if (!updatedNetworks.any { it["ssid"] as? String == network["ssid"] as? String }) {
                    updatedNetworks.add(network)
                }
            }
            GlassesStore.apply("core", "wifiScanResults", updatedNetworks)
        }

        /** Send gallery status - matches iOS MentraLive.swift handleGalleryStatus pattern */
        @JvmStatic
        fun sendGalleryStatus(
                photoCount: Int,
                videoCount: Int,
                totalCount: Int,
                totalSize: Long,
                hasContent: Boolean
        ) {
            val galleryData = HashMap<String, Any>()
            galleryData["photos"] = photoCount
            galleryData["videos"] = videoCount
            galleryData["total"] = totalCount
            galleryData["total_size"] = totalSize
            galleryData["has_content"] = hasContent

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
            val eventBody = HashMap<String, Any>()
            eventBody["enabled"] = enabled
            eventBody["ssid"] = ssid
            eventBody["password"] = password
            eventBody["local_ip"] = gatewayIp // Using gateway IP for consistency with iOS

            sendTypedMessage("hotspot_status_change", eventBody as Map<String, Any>)
        }

        /** Send hotspot error - notifies React Native of hotspot failures */
        @JvmStatic
        fun sendHotspotError(errorMessage: String, timestamp: Long) {
            val eventBody = HashMap<String, Any>()
            eventBody["error_message"] = errorMessage
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

        /**
         * Send OTA update available notification - glasses have detected an available update
         * (background mode)
         */
        @JvmStatic
        fun sendOtaUpdateAvailable(
                versionCode: Long,
                versionName: String,
                updates: List<String>,
                totalSize: Long
        ) {
            val eventBody = HashMap<String, Any>()
            eventBody["version_code"] = versionCode
            eventBody["version_name"] = versionName
            eventBody["updates"] = updates
            eventBody["total_size"] = totalSize

            sendTypedMessage("ota_update_available", eventBody as Map<String, Any>)
        }

        /** Send ota_start_ack — glasses confirmed receipt of ota_start command */
        @JvmStatic
        fun sendOtaStartAck() {
            val eventBody = HashMap<String, Any>()
            eventBody["timestamp"] = System.currentTimeMillis()
            sendTypedMessage("ota_start_ack", eventBody as Map<String, Any>)
        }

        @JvmStatic
        fun sendOtaStatus(
                sessionId: String,
                totalSteps: Int,
                currentStep: Int,
                stepType: String,
                phase: String,
                stepPercent: Int,
                overallPercent: Int,
                status: String,
                errorMessage: String?
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
    }

    init {
        deviceManager = CoreManager.Companion.getInstance()
        if (deviceManager == null) {
            Log.e(TAG, "Failed to initialize CoreManager in Bridge constructor")
        }
    }
}
