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
import kotlin.jvm.JvmStatic
import kotlin.jvm.Synchronized
import kotlin.jvm.Volatile
import org.json.JSONObject

/**
 * Bridge class for core communication between Expo modules and native Android code This is the
 * Android equivalent of the iOS Bridge.swift
 */
public class Bridge private constructor() {
    private var coreManager: CoreManager? = null

    companion object {
        private const val TAG = "Bridge"

        @Volatile private var instance: Bridge? = null

        // Event callback for sending events to JS
        private var eventCallback: ((String, Map<String, Any>) -> Unit)? = null

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
            appContext = context
            eventCallback = callback
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

        /** Send an event to JavaScript */
        @JvmStatic
        fun sendEvent(eventName: String, body: String) {
            val data = HashMap<String, Any>()
            data["body"] = body
            eventCallback?.invoke(eventName, data as Map<String, Any>)
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

        /**
         * Send microphone data to React Native. React Native handles the decision of whether to
         * send via UDP or WebSocket. This keeps the native layer simple and UDP logic centralized
         * in React Native.
         */
        @JvmStatic
        fun sendMicData(data: ByteArray) {
            val base64String = Base64.encodeToString(data, Base64.NO_WRAP)
            val body = HashMap<String, Any>()
            body["base64"] = base64String
            sendTypedMessage("mic_data", body as Map<String, Any>)
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
        fun sendVadStatus(isSpeaking: Boolean) {
            val vadMsg = HashMap<String, Any>()
            vadMsg["type"] = "VAD"
            vadMsg["status"] = isSpeaking

            try {
                val jsonObject = JSONObject(vadMsg as Map<*, *>)
                val jsonString = jsonObject.toString()
                sendWSText(jsonString)
            } catch (e: Exception) {
                Log.e(TAG, "Error sending VAD status", e)
            }
        }

        /** Send battery status */
        @JvmStatic
        fun sendBatteryStatus(level: Int, charging: Boolean) {
            val vadMsg = HashMap<String, Any>()
            vadMsg["type"] = "glasses_battery_update"
            vadMsg["level"] = level
            vadMsg["charging"] = charging
            vadMsg["timestamp"] = System.currentTimeMillis()
            // TODO: time remaining

            try {
                val jsonObject = JSONObject(vadMsg as Map<*, *>)
                val jsonString = jsonObject.toString()
                sendWSText(jsonString)
            } catch (e: Exception) {
                Log.e(TAG, "Error sending battery status", e)
            }
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

        /** Update ASR config */
        @JvmStatic
        fun updateAsrConfig(languages: List<Map<String, Any>>) {
            try {
                val configMsg = HashMap<String, Any>()
                configMsg["type"] = "config"
                configMsg["streams"] = languages

                val jsonData = JSONObject(configMsg as Map<*, *>)
                val jsonString = jsonData.toString()
                sendWSText(jsonString)
            } catch (e: Exception) {
                log("ServerComms: Error building config message: $e")
            }
        }

        /** Send core status */
        @JvmStatic
        fun sendCoreStatus(status: Map<String, Any>) {
            try {
                val event = HashMap<String, Any>()
                event["type"] = "core_status_update"
                val statusMap = HashMap<String, Any>()
                statusMap["status"] = status
                event["status"] = statusMap
                event["timestamp"] = System.currentTimeMillis().toInt()

                val jsonData = JSONObject(event as Map<*, *>)
                val jsonString = jsonData.toString()
                sendWSText(jsonString)
            } catch (e: Exception) {
                log("ServerComms: Error building core_status_update JSON: $e")
            }
        }

        // MARK: - Hardware Events

        /** Send button press to server (WebSocket) */
        @JvmStatic
        fun sendButtonPress(buttonId: String, pressType: String) {
            try {
                val event = HashMap<String, Any>()
                event["type"] = "button_press"
                event["buttonId"] = buttonId
                event["pressType"] = pressType
                event["timestamp"] = System.currentTimeMillis().toInt()

                val jsonData = JSONObject(event as Map<*, *>)
                val jsonString = jsonData.toString()
                sendWSText(jsonString)
            } catch (e: Exception) {
                log("ServerComms: Error building button_press JSON: $e")
            }
        }

        /** Send button press event to React Native - matches iOS implementation */
        @JvmStatic
        fun sendButtonPressEvent(buttonId: String, pressType: String) {
            val buttonData = HashMap<String, Any>()
            buttonData["buttonId"] = buttonId
            buttonData["pressType"] = pressType
            buttonData["timestamp"] = System.currentTimeMillis()

            sendTypedMessage("button_press", buttonData as Map<String, Any>)
        }

        /** Send touch/gesture event from glasses - matches iOS implementation */
        @JvmStatic
        fun sendTouchEvent(deviceModel: String, gestureName: String, timestamp: Long) {
            val body = HashMap<String, Any>()
            body["device_model"] = deviceModel
            body["gesture_name"] = gestureName
            body["timestamp"] = timestamp
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

        /** Send photo response */
        @JvmStatic
        fun sendPhotoResponse(requestId: String, photoUrl: String) {
            val event = HashMap<String, Any>()
            event["type"] = "photo_response"
            event["requestId"] = requestId
            event["photoUrl"] = photoUrl
            event["timestamp"] = System.currentTimeMillis().toInt()
            event["success"] = true
            sendTypedMessage("photo_response", event as Map<String, Any>)
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
            // sendWSText(JSONObject(event as Map<*, *>).toString())
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

        /** Send video stream response */
        @JvmStatic
        fun sendVideoStreamResponse(appId: String, streamUrl: String) {
            try {
                val event = HashMap<String, Any>()
                event["type"] = "video_stream_response"
                event["appId"] = appId
                event["streamUrl"] = streamUrl
                event["timestamp"] = System.currentTimeMillis().toInt()

                val jsonData = JSONObject(event as Map<*, *>)
                val jsonString = jsonData.toString()
                sendWSText(jsonString)
            } catch (e: Exception) {
                log("ServerComms: Error building video_stream_response JSON: $e")
            }
        }

        /** Send head position */
        @JvmStatic
        fun sendHeadPosition(isUp: Boolean) {
            try {
                val event = HashMap<String, Any>()
                event["type"] = "head_position"
                event["position"] = if (isUp) "up" else "down"
                event["timestamp"] = System.currentTimeMillis().toInt()

                val jsonData = JSONObject(event as Map<*, *>)
                val jsonString = jsonData.toString()
                sendWSText(jsonString)
            } catch (e: Exception) {
                log("ServerComms: Error sending head position: $e")
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

        // Core bridge funcs:

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

        /** Send OTA progress update - glasses are downloading/installing an update */
        @JvmStatic
        fun sendOtaProgress(
                stage: String,
                status: String,
                progress: Int,
                bytesDownloaded: Long,
                totalBytes: Long,
                currentUpdate: String,
                errorMessage: String?
        ) {
            val eventBody = HashMap<String, Any>()
            eventBody["stage"] = stage
            eventBody["status"] = status
            eventBody["progress"] = progress
            eventBody["bytes_downloaded"] = bytesDownloaded
            eventBody["total_bytes"] = totalBytes
            eventBody["current_update"] = currentUpdate
            errorMessage?.let { eventBody["error_message"] = it }

            sendTypedMessage("ota_progress", eventBody as Map<String, Any>)
        }

        /** Send RTMP stream status - forwards to websocket system (matches iOS) */
        @JvmStatic
        fun sendRtmpStreamStatus(statusJson: Map<String, Any>) {
            sendTypedMessage("rtmp_stream_status", statusJson)
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

        /** Send phone notification to server (via REST through TypeScript) */
        @JvmStatic
        fun sendPhoneNotification(
                notificationKey: String,
                packageName: String,
                appName: String,
                title: String,
                text: String,
                timestamp: Long
        ) {
            try {
                log("NOTIF: Attempting to send notification from $appName: $title")
                val data = HashMap<String, Any>()
                data["notificationId"] =
                        "$packageName-$notificationKey" // Stable ID combining package and Android
                // key
                data["app"] = appName
                data["title"] = title
                data["content"] = text
                data["priority"] = "normal" // Default priority, could be enhanced later
                data["timestamp"] = timestamp
                data["packageName"] = packageName

                sendTypedMessage("phone_notification", data as Map<String, Any>)
                log("NOTIF: Successfully queued phone notification: $title - $text")
            } catch (e: Exception) {
                Log.e(TAG, "NOTIF: Error sending phone notification from $packageName", e)
            }
        }

        /** Send phone notification dismissed to server (via REST through TypeScript) */
        @JvmStatic
        fun sendPhoneNotificationDismissed(notificationKey: String, packageName: String) {
            try {
                log("NOTIF: Attempting to send dismissal for $packageName")
                val data = HashMap<String, Any>()
                data["notificationId"] =
                        "$packageName-$notificationKey" // Same format as posting for correlation
                data["notificationKey"] = notificationKey // Keep Android key for reference
                data["packageName"] = packageName

                sendTypedMessage("phone_notification_dismissed", data as Map<String, Any>)
                log("NOTIF: Successfully queued notification dismissal: $notificationKey")
            } catch (e: Exception) {
                Log.e(TAG, "NOTIF: Error sending notification dismissal for $packageName", e)
            }
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
                // Check if event callback is available before proceeding
                if (eventCallback == null) {
                    Log.w(
                            TAG,
                            "Cannot send typed message '$type': eventCallback is null (app may be killed/backgrounded)"
                    )
                    return
                }

                // Send directly using type as event name - no JSON serialization
                try {
                    eventCallback?.invoke(type, mutableBody as Map<String, Any>)
                } catch (e: Exception) {
                    Log.e(
                            TAG,
                            "Error invoking eventCallback for type '$type' (React Native may be dead)",
                            e
                    )
                    // Don't rethrow - this prevents crashes when RN context is destroyed
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error sending typed message of type '$type'", e)
            }
        }
    }

    init {
        coreManager = CoreManager.Companion.getInstance()
        if (coreManager == null) {
            Log.e(TAG, "Failed to initialize CoreManager in Bridge constructor")
        }
    }
}
