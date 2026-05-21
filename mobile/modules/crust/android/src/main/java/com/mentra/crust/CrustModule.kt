package com.mentra.crust

import android.util.Log
import com.mentra.crust.services.NotificationListener
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.URL

class CrustModule : Module() {
  companion object {
    private const val TAG = "CrustModule"

    @Volatile private var eventEmitter: ((String, Map<String, Any>) -> Unit)? = null

    fun emitPhoneNotification(
            notificationKey: String,
            packageName: String,
            appName: String,
            title: String,
            text: String,
            timestamp: Long,
    ) {
      val data =
              mapOf(
                      "notificationId" to "$packageName-$notificationKey",
                      "app" to appName,
                      "title" to title.ifEmpty { appName },
                      "content" to text,
                      "priority" to "normal",
                      "timestamp" to timestamp,
                      "packageName" to packageName,
              )
      emitEvent("phone_notification", data)
    }

    fun emitPhoneNotificationDismissed(notificationKey: String, packageName: String) {
      val data =
              mapOf(
                      "notificationId" to "$packageName-$notificationKey",
                      "notificationKey" to notificationKey,
                      "packageName" to packageName,
              )
      emitEvent("phone_notification_dismissed", data)
    }

    fun emitCaptionsTesterIncident(data: Map<String, Any>) {
      emitEvent("captions_tester_incident", data)
    }

    private fun emitEvent(eventName: String, data: Map<String, Any>) {
      val emitter = eventEmitter
      if (emitter == null) {
        Log.w(TAG, "Cannot emit $eventName: event emitter is not available")
        return
      }

      try {
        emitter.invoke(eventName, data)
      } catch (e: Exception) {
        Log.e(TAG, "Error emitting $eventName event", e)
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("Crust")

    Constant("PI") { Math.PI }

    Events(
            "onChange",
            "phone_notification",
            "phone_notification_dismissed",
            "captions_tester_incident"
    )

    OnCreate { eventEmitter = { eventName, data -> sendEvent(eventName, data) } }

    Function("hello") { "Hello world! 👋" }

    AsyncFunction("setValueAsync") { value: String ->
      sendEvent("onChange", mapOf("value" to value))
    }

    Function("showAVRoutePicker") { _: String? ->
      // iOS-only; Android uses system Bluetooth settings / Crust where appropriate.
    }

    // MARK: - MentraOS Notification Commands

    AsyncFunction("setNotificationConfig") { enabled: Boolean, blocklist: List<String> ->
      val context =
              appContext.reactContext
                      ?: appContext.currentActivity
                              ?: throw IllegalStateException("No context available")
      NotificationListener.getInstance(context).setNotificationConfig(enabled, blocklist)
    }

    AsyncFunction("getInstalledApps") {
      val context =
              appContext.reactContext
                      ?: appContext.currentActivity
                              ?: throw IllegalStateException("No context available")
      NotificationListener.getInstance(context).getInstalledApps()
    }

    AsyncFunction("getInstalledAppsForNotifications") {
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

    AsyncFunction("openNotificationListenerSettings") {
      val context =
              appContext.reactContext
                      ?: appContext.currentActivity
                              ?: throw IllegalStateException("No context available")
      NotificationListener.getInstance(context).openNotificationListenerSettings()
      true
    }

    // MARK: - Build Environment

    AsyncFunction("isBetaBuild") { false }

    View(CrustView::class) {
      Prop("url") { view: CrustView, url: URL -> view.webView.loadUrl(url.toString()) }
      Events("onLoad")
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

    // MARK: - Location Services Commands

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
      val providerEnabled =
              locationManager.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER) ||
                      locationManager.isProviderEnabled(
                              android.location.LocationManager.NETWORK_PROVIDER
                      )
      if (!providerEnabled) {
        // Fallback: check the system-level location toggle directly.
        // GPS_PROVIDER/NETWORK_PROVIDER can report disabled on devices without
        // Google Play Services or without a GPS chip, even when location is toggled on.
        // isLocationEnabled requires API 28+; on older devices just trust the provider check.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
          val systemEnabled = locationManager.isLocationEnabled
          if (systemEnabled) {
            android.util.Log.w(
                    "CoreModule",
                    "Location providers (GPS/Network) report disabled but system location toggle is ON. Device may lack GMS or GPS hardware."
            )
          }
          systemEnabled
        } else {
          false
        }
      } else {
        true
      }
    }

    AsyncFunction("openLocationSettings") {
      val context =
              appContext.reactContext
                      ?: appContext.currentActivity
                              ?: throw IllegalStateException("No context available")
      val intent = android.content.Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS)
      intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      true
    }

    AsyncFunction("openAppSettings") {
      val context =
              appContext.reactContext
                      ?: appContext.currentActivity
                              ?: throw IllegalStateException("No context available")
      val intent =
              android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
      intent.data = android.net.Uri.parse("package:${context.packageName}")
      intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      true
    }

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

    AsyncFunction("showLocationServicesDialog") {
      val activity = appContext.currentActivity
      if (activity == null) {
        val context = appContext.reactContext ?: throw IllegalStateException("No context available")
        val intent =
                android.content.Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS)
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

      val client = com.google.android.gms.location.LocationServices.getSettingsClient(activity)
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
                  android.content.Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS)
          intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
          activity.startActivity(intent)
        }
      }
      true
    }

    // MARK: - Image Processing Commands

    AsyncFunction("processGalleryImage") {
            inputPath: String,
            outputPath: String,
            options: Map<String, Any?> ->
      try {
        val inputFile = java.io.File(inputPath)
        if (!inputFile.exists()) {
          throw IllegalArgumentException("Input file does not exist: $inputPath")
        }

        val lensCorrection = options["lensCorrection"] as? Boolean ?: true
        val colorCorrection = options["colorCorrection"] as? Boolean ?: true

        val processingTimeMs =
                com.mentra.crust.utils.ImageProcessor.process(
                        inputPath,
                        outputPath,
                        lensCorrection,
                        colorCorrection,
                        95
                )

        if (processingTimeMs >= 0) {
          mapOf(
                  "success" to true,
                  "outputPath" to outputPath,
                  "processingTimeMs" to processingTimeMs
          )
        } else {
          mapOf("success" to false, "error" to "Processing failed")
        }
      } catch (e: Exception) {
        android.util.Log.e("CrustModule", "processGalleryImage error: ${e.message}", e)
        mapOf("success" to false, "error" to (e.message ?: "Unknown error"))
      }
    }

    // MARK: - HDR Merge Commands

    AsyncFunction("mergeHdrBrackets") {
            underPath: String,
            normalPath: String,
            overPath: String,
            outputPath: String ->
      try {
        val processingTimeMs =
                com.mentra.crust.utils.ImageProcessor.mergeHdr(
                        underPath,
                        normalPath,
                        overPath,
                        outputPath,
                        95
                )
        if (processingTimeMs >= 0) {
          mapOf(
                  "success" to true,
                  "outputPath" to outputPath,
                  "processingTimeMs" to processingTimeMs
          )
        } else {
          mapOf("success" to false, "error" to "HDR merge failed")
        }
      } catch (e: Exception) {
        android.util.Log.e("CrustModule", "mergeHdrBrackets error: ${e.message}", e)
        mapOf("success" to false, "error" to (e.message ?: "Unknown error"))
      }
    }

    // MARK: - Video Stabilization Commands

    AsyncFunction("stabilizeVideo") { inputPath: String, imuPath: String, outputPath: String ->
      try {
        val inputFile = java.io.File(inputPath)
        val imuFile = java.io.File(imuPath)
        if (!inputFile.exists()) {
          throw IllegalArgumentException("Input video does not exist: $inputPath")
        }
        if (!imuFile.exists()) {
          throw IllegalArgumentException("IMU sidecar does not exist: $imuPath")
        }

        val processingTimeMs =
                com.mentra.crust.utils.VideoStabilizer.stabilize(inputPath, imuPath, outputPath)

        if (processingTimeMs >= 0) {
          mapOf(
                  "success" to true,
                  "outputPath" to outputPath,
                  "processingTimeMs" to processingTimeMs
          )
        } else {
          mapOf("success" to false, "error" to "Stabilization failed")
        }
      } catch (e: Exception) {
        android.util.Log.e("CrustModule", "stabilizeVideo error: ${e.message}", e)
        mapOf("success" to false, "error" to (e.message ?: "Unknown error"))
      }
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
                  if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                    android.provider.MediaStore.Video.Media.getContentUri(
                            android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY
                    )
                  } else {
                    android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                  }
                } else {
                  if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
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

                  if (captureTimeMillis != null) {
                    if (isVideo) {
                      put(android.provider.MediaStore.Video.Media.DATE_TAKEN, captureTimeMillis)
                    } else {
                      put(android.provider.MediaStore.Images.Media.DATE_TAKEN, captureTimeMillis)
                    }
                    android.util.Log.d(
                            "CrustModule",
                            "Setting DATE_TAKEN to: $captureTimeMillis (${java.util.Date(captureTimeMillis)})"
                    )
                  }

                  if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                    val relativePath =
                            if (isVideo) {
                              "Movies/Mentra"
                            } else {
                              "Pictures/Mentra"
                            }
                    put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
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
                  "CrustModule",
                  "Successfully saved to gallery with proper DATE_TAKEN: ${file.name}"
          )
          mapOf("success" to true, "uri" to uri.toString())
        } catch (e: Exception) {
          resolver.delete(uri, null, null)
          throw e
        }
      } catch (e: Exception) {
        android.util.Log.e("CrustModule", "Error saving to gallery: ${e.message}", e)
        mapOf("success" to false, "error" to e.message)
      }
    }
  }
}
