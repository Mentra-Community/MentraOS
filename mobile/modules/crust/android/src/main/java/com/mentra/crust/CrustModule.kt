package com.mentra.crust

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.URL

class CrustModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Crust")

    Constant("PI") {
      Math.PI
    }

    Events(
      "onChange",
      "onNavManeuver",
      "onNavRerouting",
      "onNavArrived",
      "onNavError",
      "onNavLocation",
      "onNavRoute",
      "onHeading",
    )

    Function("hello") {
      "Hello world! 👋"
    }

    AsyncFunction("setValueAsync") { value: String ->
      sendEvent("onChange", mapOf(
        "value" to value
      ))
    }

    View(CrustView::class) {
      Prop("url") { view: CrustView, url: URL ->
        view.webView.loadUrl(url.toString())
      }
      Events("onLoad")
    }

    // MARK: - Image Processing Commands

    AsyncFunction("processGalleryImage") { inputPath: String, outputPath: String, options: Map<String, Any?> ->
      try {
        val inputFile = java.io.File(inputPath)
        if (!inputFile.exists()) {
          throw IllegalArgumentException("Input file does not exist: $inputPath")
        }

        val lensCorrection = options["lensCorrection"] as? Boolean ?: true
        val colorCorrection = options["colorCorrection"] as? Boolean ?: true

        val processingTimeMs = com.mentra.crust.utils.ImageProcessor.process(
          inputPath, outputPath, lensCorrection, colorCorrection, 95
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

    AsyncFunction("mergeHdrBrackets") { underPath: String, normalPath: String, overPath: String, outputPath: String ->
      try {
        val processingTimeMs = com.mentra.crust.utils.ImageProcessor.mergeHdr(
          underPath, normalPath, overPath, outputPath, 95
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

        val processingTimeMs = com.mentra.crust.utils.VideoStabilizer.stabilize(
          inputPath, imuPath, outputPath
        )

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
          } ?: throw IllegalStateException("Failed to open output stream")

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

    // MARK: - Navigation Commands (Google Navigation SDK)

    AsyncFunction("startNavigation") { lat: Double, lng: Double ->
      val activity = appContext.currentActivity
        ?: return@AsyncFunction mapOf("ok" to false, "error" to "no current activity (app backgrounded?)")

      val callbacks = object : NavigationManager.Callbacks {
        override fun onManeuver(payload: NavigationManager.ManeuverPayload) {
          sendEvent(
            "onNavManeuver",
            mapOf(
              "instruction" to payload.instruction,
              "roadName" to payload.roadName,
              "maneuverType" to payload.maneuverType,
              "distanceMeters" to payload.distanceMeters,
              "towardRoad" to payload.towardRoad,
              "nextManeuverType" to payload.nextManeuverType,
              "nextManeuverLabel" to payload.nextManeuverLabel,
            ),
          )
        }
        override fun onRerouting() {
          sendEvent("onNavRerouting", emptyMap<String, Any?>())
        }
        override fun onArrived() {
          sendEvent("onNavArrived", emptyMap<String, Any?>())
        }
        override fun onError(message: String) {
          sendEvent("onNavError", mapOf("message" to message))
        }
        override fun onLocation(payload: NavigationManager.LocationPayload) {
          sendEvent(
            "onNavLocation",
            mapOf(
              "lat" to payload.lat,
              "lng" to payload.lng,
              "accuracy" to payload.accuracy,
              "timestamp" to payload.timestamp,
            ),
          )
        }
        override fun onRoute(points: List<NavigationManager.RoutePoint>) {
          sendEvent(
            "onNavRoute",
            mapOf(
              "points" to points.map { mapOf("lat" to it.lat, "lng" to it.lng) },
            ),
          )
        }
      }

      activity.runOnUiThread {
        // 1) Verify ACCESS_FINE_LOCATION is granted to this process. The
        //    Google Nav SDK rejects getNavigator() with LOCATION_PERMISSION_MISSING
        //    even if location was granted in another module's context — it
        //    requires PackageManager.PERMISSION_GRANTED at call-time.
        val granted = androidx.core.content.ContextCompat.checkSelfPermission(
          activity,
          android.Manifest.permission.ACCESS_FINE_LOCATION,
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED

        if (!granted) {
          // Request and abort this attempt. User taps Start again after granting.
          androidx.core.app.ActivityCompat.requestPermissions(
            activity,
            arrayOf(android.Manifest.permission.ACCESS_FINE_LOCATION),
            9001,
          )
          sendEvent(
            "onNavError",
            mapOf("message" to "ACCESS_FINE_LOCATION not granted — accept the prompt and tap Start again"),
          )
          return@runOnUiThread
        }

        // 2) Show T&C dialog (no-op after first acceptance), then start nav.
        com.google.android.libraries.navigation.NavigationApi
          .showTermsAndConditionsDialog(
            activity,
            "Mentra",
            object : com.google.android.libraries.navigation.NavigationApi.OnTermsResponseListener {
              override fun onTermsResponse(termsAccepted: Boolean) {
                if (!termsAccepted) {
                  sendEvent("onNavError", mapOf("message" to "user declined Google Nav T&C"))
                  return
                }
                NavigationManager.start(activity, lat, lng, callbacks)
              }
            },
          )
      }
      mapOf("ok" to true)
    }

    AsyncFunction("stopNavigation") {
      try {
        NavigationManager.stop()
        mapOf("ok" to true)
      } catch (e: Exception) {
        android.util.Log.e("CrustModule", "stopNavigation failed", e)
        mapOf("ok" to false, "error" to (e.message ?: "stop failed"))
      }
    }

    // MARK: - Heading (compass) — Android only

    AsyncFunction("startHeading") {
      val ctx = appContext.reactContext
        ?: appContext.currentActivity
        ?: return@AsyncFunction mapOf("ok" to false, "error" to "no context")
      HeadingManager.start(ctx, object : HeadingManager.Callback {
        override fun onHeading(degrees: Float) {
          sendEvent("onHeading", mapOf("degrees" to degrees.toDouble()))
        }
      })
      mapOf("ok" to true)
    }

    AsyncFunction("stopHeading") {
      HeadingManager.stop()
      mapOf("ok" to true)
    }
  }
}
