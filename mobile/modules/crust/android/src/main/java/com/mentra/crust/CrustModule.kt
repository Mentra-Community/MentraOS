package com.mentra.crust

import android.util.Log
import com.mentra.crust.services.NotificationListener
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.URL

import com.mentra.crust.navigation.NavigationManager
import com.mentra.crust.heading.HeadingManager
import com.mentra.crust.jsc.JSCRuntime
import com.mentra.crust.jsc.InstalledMiniappManifest
import com.mentra.crust.jsc.JSCPolyfillBridge

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
      "captions_tester_incident",
      "onNavManeuver",
      "onNavRerouting",
      "onNavArrived",
      "onNavError",
      "onNavLocation",
      "onNavRoute",
      "onNavOffRoute",
      "onHeading",
      // MentraJS — per-miniapp JSContext outbound message bus.
      // Phase 2's MentraJSRouter subscribes via Crust.addListener.
      "mentrajs_message",
    )

    OnCreate {
      eventEmitter = { eventName, data -> sendEvent(eventName, data) }
      val ctx =
              appContext.reactContext
                      ?: appContext.currentActivity
      if (ctx != null) {
        val runtime = JSCRuntime.shared(ctx)
        runtime.onOutbound = { msg ->
          sendEvent("mentrajs_message", msg.payload)
        }
        JSCPolyfillBridge.install(runtime)
      } else {
        Log.w(TAG, "MentraJS: no context yet — runtime install deferred")
      }
    }

    Function("hello") {
      "Hello world! 👋"
    }

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

    // MARK: - MentraJS Runtime (Phase 1)

    AsyncFunction("mentraJsSpawn") { packageName: String, polyfillBundle: String, miniappJs: String ->
      val ctx =
              appContext.reactContext
                      ?: appContext.currentActivity
                              ?: throw IllegalStateException("MentraJS: no context")
      JSCRuntime.shared(ctx).spawn(
          packageName = packageName,
          polyfillBundleOverride = polyfillBundle.takeIf { it.isNotEmpty() },
          miniappJs = miniappJs,
      )
    }

    AsyncFunction("mentraJsEvaluate") { packageName: String, source: String ->
      val ctx =
              appContext.reactContext
                      ?: appContext.currentActivity
                              ?: throw IllegalStateException("MentraJS: no context")
      JSCRuntime.shared(ctx).evaluate(packageName, source)
    }

    AsyncFunction("mentraJsKill") { packageName: String ->
      val ctx =
              appContext.reactContext
                      ?: appContext.currentActivity
                              ?: throw IllegalStateException("MentraJS: no context")
      JSCRuntime.shared(ctx).kill(packageName)
    }

    AsyncFunction("mentraJsDispatchToJs") { packageName: String, envelope: Map<String, Any?> ->
      val ctx =
              appContext.reactContext
                      ?: appContext.currentActivity
                              ?: throw IllegalStateException("MentraJS: no context")
      val json = org.json.JSONObject(envelope as Map<*, *>).toString()
      JSCRuntime.shared(ctx).dispatchToJs(packageName, json)
    }

    AsyncFunction("mentraJsSetManifest") { packageName: String, permissions: List<String> ->
      val ctx =
              appContext.reactContext
                      ?: appContext.currentActivity
                              ?: throw IllegalStateException("MentraJS: no context")
      JSCRuntime.shared(ctx).dispatcher.setManifest(
          packageName,
          InstalledMiniappManifest(permissions.toSet()),
      )
    }

    AsyncFunction("mentraJsGrantPermission") { packageName: String, permission: String, granted: Boolean ->
      val ctx =
              appContext.reactContext
                      ?: appContext.currentActivity
                              ?: throw IllegalStateException("MentraJS: no context")
      val runtime = JSCRuntime.shared(ctx)
      if (granted) {
        runtime.dispatcher.permissionStore.grant(packageName, permission)
      } else {
        runtime.dispatcher.permissionStore.revoke(packageName, permission)
      }
    }

    Function("mentraJsAlivePackages") {
      val ctx =
              appContext.reactContext
                      ?: appContext.currentActivity
      if (ctx == null) {
        return@Function emptyList<String>()
      }
      JSCRuntime.shared(ctx).alivePackages()
    }

    Function("mentraJsLoadPolyfillBundle") {
      val ctx =
              appContext.reactContext
                      ?: appContext.currentActivity
      if (ctx == null) {
        return@Function ""
      }
      JSCRuntime.shared(ctx).loadPolyfillBundle()
    }

    // MARK: - Device Memory (Phase 0 LRU eviction)

    // Returns the device's total physical RAM in bytes. The Phase 0 LRU
    // eviction policy is a no-op on Android — multiple WebViews share a
    // single renderer process, so the jetsam wall doesn't apply. We still
    // expose a real value (via ActivityManager.MemoryInfo.totalMem) so JS
    // can log the tier label for diagnostics, but the eviction policy
    // wired in MiniappHost short-circuits to "unlimited" when this number
    // is 0. Returning 0 (== unknown) is the safe default in case the
    // ActivityManager lookup fails or isn't available.
    Function("getPhysicalMemoryBytes") {
      val ctx = appContext.reactContext ?: appContext.currentActivity
      if (ctx == null) {
        return@Function 0.0
      }
      try {
        val am =
                ctx.getSystemService(android.content.Context.ACTIVITY_SERVICE)
                        as? android.app.ActivityManager
                        ?: return@Function 0.0
        val mi = android.app.ActivityManager.MemoryInfo()
        am.getMemoryInfo(mi)
        // mi.totalMem is bytes (Long). Convert to Double for the JS bridge.
        return@Function mi.totalMem.toDouble()
      } catch (e: Throwable) {
        Log.w(TAG, "getPhysicalMemoryBytes: failed", e)
        return@Function 0.0
      }
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

    // MARK: - Navigation Commands (Google Navigation SDK)

    AsyncFunction("startNavigation") { lat: Double, lng: Double, options: Map<String, Any?>? ->
      val activity = appContext.currentActivity
        ?: return@AsyncFunction mapOf("ok" to false, "error" to "no current activity (app backgrounded?)")
      val simulate = (options?.get("simulate") as? Boolean) ?: false
      val speed = (options?.get("speedMultiplier") as? Number)?.toFloat() ?: 5f
      val mode = (options?.get("mode") as? String) ?: "driving"

      // Prefer the v2 `stops` array when present. Fall back to lat/lng for
      // older callers that haven't been upgraded yet.
      val rawStops = options?.get("stops") as? List<*>
      val stops: List<Pair<Double, Double>> = if (rawStops != null && rawStops.isNotEmpty()) {
        rawStops.mapNotNull { item ->
          val map = item as? Map<*, *> ?: return@mapNotNull null
          val sLat = (map["lat"] as? Number)?.toDouble() ?: return@mapNotNull null
          val sLng = (map["lng"] as? Number)?.toDouble() ?: return@mapNotNull null
          sLat to sLng
        }
      } else {
        listOf(lat to lng)
      }
      if (stops.isEmpty()) {
        return@AsyncFunction mapOf("ok" to false, "error" to "no valid stops")
      }

      val avoidMap = options?.get("avoid") as? Map<*, *>
      val avoidHighways = (avoidMap?.get("highways") as? Boolean) ?: false
      val avoidTolls = (avoidMap?.get("tolls") as? Boolean) ?: false
      val avoidFerries = (avoidMap?.get("ferries") as? Boolean) ?: false

      val callbacks = object : NavigationManager.Callbacks {
        override fun onManeuver(payload: NavigationManager.ManeuverPayload) {
          sendEvent(
            "onNavManeuver",
            mapOf(
              "maneuverType" to payload.maneuverType,
              "distanceMeters" to payload.distanceMeters,
              "fromRoad" to payload.fromRoad,
              "toRoad" to payload.toRoad,
              "nextStepRoad" to payload.nextStepRoad,
              "distanceToDestinationMeters" to payload.distanceToDestinationMeters,
              "timeToDestinationSeconds" to payload.timeToDestinationSeconds,
              "currentSpeedMps" to payload.currentSpeedMps,
              "speedLimitMps" to payload.speedLimitMps,
              "routeHeadingDeg" to payload.routeHeadingDeg,
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
        override fun onRoute(
          points: List<NavigationManager.RoutePoint>,
          steps: List<NavigationManager.RouteStep>?,
        ) {
          val payload = HashMap<String, Any?>()
          payload["points"] = points.map { mapOf("lat" to it.lat, "lng" to it.lng) }
          if (steps != null) {
            payload["steps"] = steps.map {
              mapOf(
                "lat" to it.lat,
                "lng" to it.lng,
                "routeIndex" to it.routeIndex,
                "road" to it.road,
                "maneuver" to it.maneuver,
                "distanceMeters" to it.distanceMeters,
              )
            }
          }
          sendEvent("onNavRoute", payload)
        }
        override fun onOffRoute(perpendicularDistanceMeters: Double) {
          sendEvent(
            "onNavOffRoute",
            mapOf("offRouteDistanceMeters" to perpendicularDistanceMeters),
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

        // 2) NavigationManager owns the T&C flow — it shows the dialog
        //    only on the very first run (persisted), and passes
        //    `SKIPPED` to `getNavigator` afterward to suppress the
        //    "Welcome to Google Maps" toast.
        NavigationManager.start(
          activity,
          NavigationManager.StartOptions(
            stops = stops,
            mode = mode,
            avoidHighways = avoidHighways,
            avoidTolls = avoidTolls,
            avoidFerries = avoidFerries,
            simulate = simulate,
            speedMultiplier = speed,
          ),
          callbacks,
        )
      }
      mapOf("ok" to true)
    }

    // Eager T&C dialog. Lets a miniapp surface the Google Nav SDK terms
    // dialog at mount time so the actual startNavigation() call later is
    // friction-free. Idempotent — resolves immediately when the user has
    // already accepted (in-process flag, on-disk pref, or SDK state).
    AsyncFunction("requestNavigationPermission") { promise: expo.modules.kotlin.Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(mapOf("ok" to false, "accepted" to false, "error" to "no current activity"))
        return@AsyncFunction
      }
      activity.runOnUiThread {
        NavigationManager.ensureTermsAccepted(activity) { accepted ->
          promise.resolve(mapOf("ok" to true, "accepted" to accepted))
        }
      }
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

    // Dev-only: nudge the simulated position ~offsetMeters off-route to
    // exercise the Nav SDK's onRerouting() pipeline without having to
    // physically walk off the planned path. No-op on real GPS fixes.
    AsyncFunction("simulateDeviation") { offsetMeters: Double? ->
      try {
        NavigationManager.simulateDeviation(offsetMeters ?: 20.0)
        mapOf("ok" to true)
      } catch (e: Exception) {
        android.util.Log.e("CrustModule", "simulateDeviation failed", e)
        mapOf("ok" to false, "error" to (e.message ?: "deviate failed"))
      }
    }

    AsyncFunction("setWrongSidewalkOffset") { enabled: Boolean ->
      try {
        NavigationManager.setWrongSidewalkOffset(enabled)
        mapOf("ok" to true)
      } catch (e: Exception) {
        android.util.Log.e("CrustModule", "setWrongSidewalkOffset failed", e)
        mapOf("ok" to false, "error" to (e.message ?: "setWrongSidewalkOffset failed"))
      }
    }

    AsyncFunction("setSkipCrossings") { enabled: Boolean ->
      try {
        NavigationManager.setSkipCrossings(enabled)
        mapOf("ok" to true)
      } catch (e: Exception) {
        android.util.Log.e("CrustModule", "setSkipCrossings failed", e)
        mapOf("ok" to false, "error" to (e.message ?: "setSkipCrossings failed"))
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
