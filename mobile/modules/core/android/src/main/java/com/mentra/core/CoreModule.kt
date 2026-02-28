package com.mentra.core

import com.mentra.core.services.NotificationListener
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CoreModule : Module() {
    private val bridge: Bridge by lazy { Bridge.getInstance() }
    private var coreManager: CoreManager? = null

    override fun definition() = ModuleDefinition {
        Name("Core")

        // Define events that can be sent to JavaScript
        Events(
            "glasses_status",
            "core_status",
            "log",
            // Individual event handlers
            "glasses_not_ready",
            "button_press",
            "touch_event",
            "head_up",
            "battery_status",
            "local_transcription",
            "wifi_status_change",
            "hotspot_status_change",
            "hotspot_error",
            "gallery_status",
            "compatible_glasses_search_stop",
            "heartbeat_sent",
            "heartbeat_received",
            "swipe_volume_status",
            "switch_status",
            "rgb_led_control_response",
            "pair_failure",
            "audio_pairing_needed",
            "audio_connected",
            "audio_disconnected",
            "save_setting",
            "phone_notification",
            "phone_notification_dismissed",
            "ws_text",
            "ws_bin",
            "mic_data",
            "rtmp_stream_status",
            "keep_alive_ack",
            "mtk_update_complete",
            "ota_update_available",
            "ota_progress",
        )

        OnCreate {
            // Initialize Bridge with Android context and event callback
            Bridge.initialize(
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            ) { eventName, data -> sendEvent(eventName, data) }

            // initialize CoreManager after Bridge is ready
            coreManager = CoreManager.getInstance()

            // Configure observable store event emission
            GlassesStore.store.configure { category, changes ->
                when (category) {
                    "glasses" -> sendEvent("glasses_status", changes)
                    "core" -> sendEvent("core_status", changes)
                }
            }
        }

        // MARK: - Observable Store Functions

        Function("getGlassesStatus") { GlassesStore.store.getCategory("glasses") }

        Function("getCoreStatus") { GlassesStore.store.getCategory("core") }

        Function("set") { category: String, key: String, value: Any ->
            GlassesStore.apply(category, key, value)
        }

        Function("update") { category: String, values: Map<String, Any> ->
            values.forEach { (key, value) -> GlassesStore.apply(category, key, value) }
        }

        // MARK: - Display Commands

        AsyncFunction("displayEvent") { params: Map<String, Any> ->
            coreManager?.displayEvent(params)
        }

        AsyncFunction("displayText") { params: Map<String, Any> ->
            coreManager?.displayText(params)
        }

        AsyncFunction("clearDisplay") { coreManager?.clearDisplay() }

        // MARK: - Connection Commands

        AsyncFunction("connectDefault") { coreManager?.connectDefault() }

        AsyncFunction("connectByName") { deviceName: String ->
            coreManager?.connectByName(deviceName)
        }

        AsyncFunction("connectSimulated") { coreManager?.connectSimulated() }

        AsyncFunction("disconnect") { coreManager?.disconnect() }

        AsyncFunction("forget") { coreManager?.forget() }

        AsyncFunction("findCompatibleDevices") { deviceModel: String ->
            coreManager?.findCompatibleDevices(deviceModel)
        }

        AsyncFunction("showDashboard") { coreManager?.showDashboard() }

        // MARK: - WiFi Commands

        AsyncFunction("requestWifiScan") { coreManager?.requestWifiScan() }

        AsyncFunction("sendWifiCredentials") { ssid: String, password: String ->
            coreManager?.sendWifiCredentials(ssid, password)
        }

        AsyncFunction("forgetWifiNetwork") { ssid: String -> coreManager?.forgetWifiNetwork(ssid) }

        AsyncFunction("setHotspotState") { enabled: Boolean ->
            coreManager?.setHotspotState(enabled)
        }

        // MARK: - Gallery Commands

        AsyncFunction("queryGalleryStatus") { coreManager?.queryGalleryStatus() }

        AsyncFunction("photoRequest") {
                requestId: String,
                appId: String,
                size: String,
                webhookUrl: String,
                authToken: String,
                compress: String,
                silent: Boolean ->
            coreManager?.photoRequest(
                    requestId,
                    appId,
                    size,
                    webhookUrl,
                    authToken,
                    compress,
                    silent
            )
        }

        // MARK: - OTA Commands

        AsyncFunction("sendOtaStart") { coreManager?.sendOtaStart() }

        // MARK: - Version Info Commands

        AsyncFunction("requestVersionInfo") { coreManager?.requestVersionInfo() }

        // MARK: - Power Control Commands

        AsyncFunction("sendShutdown") { coreManager?.sendShutdown() }

        AsyncFunction("sendReboot") { coreManager?.sendReboot() }

        // MARK: - Video Recording Commands

        AsyncFunction("startBufferRecording") { coreManager?.startBufferRecording() }

        AsyncFunction("stopBufferRecording") { coreManager?.stopBufferRecording() }

        AsyncFunction("saveBufferVideo") { requestId: String, durationSeconds: Int ->
            coreManager?.saveBufferVideo(requestId, durationSeconds)
        }

        AsyncFunction("startVideoRecording") { requestId: String, save: Boolean, silent: Boolean ->
            coreManager?.startVideoRecording(requestId, save, silent)
        }

        AsyncFunction("stopVideoRecording") { requestId: String ->
            coreManager?.stopVideoRecording(requestId)
        }

        // MARK: - RTMP Stream Commands

        AsyncFunction("startRtmpStream") { params: Map<String, Any> ->
            coreManager?.startRtmpStream(params.toMutableMap())
        }

        AsyncFunction("stopRtmpStream") { coreManager?.stopRtmpStream() }

        AsyncFunction("keepRtmpStreamAlive") { params: Map<String, Any> ->
            coreManager?.keepRtmpStreamAlive(params.toMutableMap())
        }

        // MARK: - Microphone Commands

        AsyncFunction("setMicState") {
                sendPcmData: Boolean,
                sendTranscript: Boolean,
                bypassVad: Boolean ->
            coreManager?.setMicState(sendPcmData, sendTranscript, bypassVad)
        }

        AsyncFunction("restartTranscriber") { coreManager?.restartTranscriber() }

        // MARK: - Audio Playback Monitoring

        AsyncFunction("setOwnAppAudioPlaying") { playing: Boolean ->
            // Notify PhoneAudioMonitor that our app started/stopped playing audio
            // This is used to suspend LC3 mic during audio playback to avoid MCU overload
            val context = appContext.reactContext ?: return@AsyncFunction
            com.mentra.core.utils.PhoneAudioMonitor.getInstance(context).setOwnAppAudioPlaying(playing)
        }

        // MARK: - RGB LED Control

        AsyncFunction("rgbLedControl") {
                requestId: String,
                packageName: String?,
                action: String,
                color: String?,
                ontime: Int,
                offtime: Int,
                count: Int ->
            coreManager?.rgbLedControl(
                    requestId,
                    packageName,
                    action,
                    color,
                    ontime,
                    offtime,
                    count
            )
        }

        // MARK: - STT Commands

        AsyncFunction("setSttModelDetails") { path: String, languageCode: String ->
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            com.mentra.core.stt.STTTools.setSttModelDetails(context, path, languageCode)
        }

        AsyncFunction("getSttModelPath") { ->
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            com.mentra.core.stt.STTTools.getSttModelPath(context)
        }

        AsyncFunction("checkSttModelAvailable") { ->
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            com.mentra.core.stt.STTTools.checkSTTModelAvailable(context)
        }

        AsyncFunction("validateSttModel") { path: String ->
            com.mentra.core.stt.STTTools.validateSTTModel(path)
        }

        AsyncFunction("extractTarBz2") { sourcePath: String, destinationPath: String ->
            com.mentra.core.stt.STTTools.extractTarBz2(sourcePath, destinationPath)
        }

        // MARK: - Android-specific Commands

        AsyncFunction("getInstalledApps") {
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            NotificationListener.getInstance(context).getInstalledApps()
        }

        AsyncFunction("hasNotificationListenerPermission") {
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            NotificationListener.getInstance(context).hasNotificationListenerPermission()
        }

        AsyncFunction("getInstalledAppsForNotifications") {
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            NotificationListener.getInstance(context).getInstalledApps()
        }

        // MARK: - Settings Navigation

        AsyncFunction("openBluetoothSettings") {
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            val intent = android.content.Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS)
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        }

        // Check if location services are enabled (required for WiFi operations on Android)
        AsyncFunction("isLocationServicesEnabled") {
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            val locationManager =
                    context.getSystemService(android.content.Context.LOCATION_SERVICE) as
                            android.location.LocationManager
            // Check if either GPS or Network location provider is enabled
            locationManager.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER) ||
                    locationManager.isProviderEnabled(
                            android.location.LocationManager.NETWORK_PROVIDER
                    )
        }

        AsyncFunction("openLocationSettings") {
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            val intent =
                    android.content.Intent(
                            android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS
                    )
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        }

        AsyncFunction("showLocationServicesDialog") {
            val activity = appContext.currentActivity
            if (activity == null) {
                val context =
                        appContext.reactContext
                                ?: throw IllegalStateException("No context available")
                val intent =
                        android.content.Intent(
                                android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS
                        )
                intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
                return@AsyncFunction true
            }

            val locationRequest =
                    com.google.android.gms.location.LocationRequest.Builder(
                                    com.google.android.gms.location.Priority.PRIORITY_HIGH_ACCURACY,
                                    10000
                            )
                            .build()

            val builder =
                    com.google.android.gms.location.LocationSettingsRequest.Builder()
                            .addLocationRequest(locationRequest)
                            .setAlwaysShow(true)

            val client =
                    com.google.android.gms.location.LocationServices.getSettingsClient(activity)
            val task = client.checkLocationSettings(builder.build())

            task.addOnSuccessListener { true }
            task.addOnFailureListener { exception ->
                if (exception is com.google.android.gms.common.api.ResolvableApiException) {
                    try {
                        exception.startResolutionForResult(activity, 1001)
                    } catch (sendEx: android.content.IntentSender.SendIntentException) {
                        // Fallback
                        val intent =
                                android.content.Intent(
                                        android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS
                                )
                        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                        activity.startActivity(intent)
                    }
                } else {
                    val intent =
                            android.content.Intent(
                                    android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS
                            )
                    intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    activity.startActivity(intent)
                }
            }
            true
        }

        AsyncFunction("openAppSettings") {
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")
            val intent =
                    android.content.Intent(
                            android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS
                    )
            intent.data = android.net.Uri.parse("package:${context.packageName}")
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        }

        // MARK: - Media Library Commands

        AsyncFunction("saveToGalleryWithDate") { filePath: String, captureTimeMillis: Long? ->
            val context =
                    appContext.reactContext
                            ?: appContext.currentActivity
                                    ?: throw IllegalStateException("No context available")

            try {
                val file = java.io.File(filePath)
                if (!file.exists()) {
                    throw IllegalArgumentException("File does not exist: $filePath")
                }

                val mimeType =
                        when (file.extension.lowercase()) {
                            "jpg", "jpeg" -> "image/jpeg"
                            "png" -> "image/png"
                            "mp4" -> "video/mp4"
                            "mov" -> "video/quicktime"
                            else -> "application/octet-stream"
                        }

                val isVideo = mimeType.startsWith("video/")
                val collection =
                        if (isVideo) {
                            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q
                            ) {
                                android.provider.MediaStore.Video.Media.getContentUri(
                                        android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY
                                )
                            } else {
                                android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                            }
                        } else {
                            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q
                            ) {
                                android.provider.MediaStore.Images.Media.getContentUri(
                                        android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY
                                )
                            } else {
                                android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                            }
                        }

                val values =
                        android.content.ContentValues().apply {
                            put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, file.name)
                            put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mimeType)
                            put(android.provider.MediaStore.MediaColumns.SIZE, file.length())

                            // Set the capture time (DATE_TAKEN) if provided
                            if (captureTimeMillis != null) {
                                if (isVideo) {
                                    put(
                                            android.provider.MediaStore.Video.Media.DATE_TAKEN,
                                            captureTimeMillis
                                    )
                                } else {
                                    put(
                                            android.provider.MediaStore.Images.Media.DATE_TAKEN,
                                            captureTimeMillis
                                    )
                                }
                                android.util.Log.d(
                                        "CoreModule",
                                        "Setting DATE_TAKEN to: $captureTimeMillis (${java.util.Date(captureTimeMillis)})"
                                )
                            }

                            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q
                            ) {
                                put(
                                        android.provider.MediaStore.MediaColumns.RELATIVE_PATH,
                                        if (isVideo) "DCIM/Camera" else "DCIM/Camera"
                                )
                                put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1)
                            }
                        }

                val resolver = context.contentResolver
                val uri =
                        resolver.insert(collection, values)
                                ?: throw IllegalStateException("Failed to create MediaStore entry")

                try {
                    resolver.openOutputStream(uri)?.use { outputStream ->
                        file.inputStream().use { inputStream -> inputStream.copyTo(outputStream) }
                    }
                            ?: throw IllegalStateException("Failed to open output stream")

                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                        values.clear()
                        values.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0)
                        resolver.update(uri, values, null, null)
                    }

                    android.util.Log.d(
                            "CoreModule",
                            "Successfully saved to gallery with proper DATE_TAKEN: ${file.name}"
                    )
                    mapOf("success" to true, "uri" to uri.toString())
                } catch (e: Exception) {
                    resolver.delete(uri, null, null)
                    throw e
                }
            } catch (e: Exception) {
                android.util.Log.e("CoreModule", "Error saving to gallery: ${e.message}", e)
                mapOf("success" to false, "error" to e.message)
            }
        }
    }
}
