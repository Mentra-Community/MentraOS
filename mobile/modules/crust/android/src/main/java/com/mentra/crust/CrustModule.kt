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
            priority: Int,
    ) {
      val data =
              mapOf(
                      "notificationId" to "$packageName-$notificationKey",
                      "app" to appName,
                      "title" to title.ifEmpty { appName },
                      "content" to text,
                      // The real Notification.priority, not a placeholder. This
                      // was hardcoded to "normal", which made every consumer's
                      // priority handling dead code — notably the spoken-
                      // notification path, which is supposed to stay quiet for
                      // PRIORITY_LOW/MIN because those are exactly the ones an
                      // app asked not to interrupt with (OS-1821).
                      "priority" to priority,
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

  // Whether the JSCRuntime's onOutbound sink + polyfill bridge have been wired
  // up. We try in OnCreate, but `appContext.reactContext` is often null that
  // early — in that case we re-attempt the install on the first AsyncFunction
  // call that can hand us a real context. Without this every host-bound
  // __dispatch from a per-miniapp QuickJS context (SUBSCRIBE, mic, location,
  // display, send, etc.) would be silently dropped on Android.
  @Volatile private var runtimeInstalled: Boolean = false

  private fun installRuntimeIfPossible(reason: String): Boolean {
    if (runtimeInstalled) return true
    val ctx = appContext.reactContext ?: appContext.currentActivity
    if (ctx == null) {
      Log.w(TAG, "MentraJS: install deferred ($reason) — no context yet")
      return false
    }
    val runtime = JSCRuntime.shared(ctx)
    runtime.onOutbound = { msg ->
      sendEvent("mentrajs_message", msg.payload)
    }
    JSCPolyfillBridge.install(runtime)
    runtimeInstalled = true
    Log.i(TAG, "MentraJS: runtime installed ($reason)")
    return true
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
      // MentraJSRouter subscribes via Crust.addListener.
      "mentrajs_message",
    )

    OnCreate {
      eventEmitter = { eventName, data -> sendEvent(eventName, data) }
      installRuntimeIfPossible("OnCreate")
    }

    Function("hello") {
      "Hello world! 👋"
    }

    AsyncFunction("setValueAsync") { value: String ->
      sendEvent("onChange", mapOf("value" to value))
    }

    AsyncFunction("nativeHttpRequest") {
      method: String, url: String, headers: Map<String, String>, body: String? ->
      val result = JSCPolyfillBridge.executeHttp(method, url, headers, body)
      mapOf(
        "status" to result.status,
        "statusText" to result.statusText,
        "headers" to result.headers,
        "body" to result.body,
      )
    }

    Function("showAVRoutePicker") { _: String? ->
      // iOS-only; Android uses system Bluetooth settings / Crust where appropriate.
    }

    AsyncFunction("setDeferredSystemGestures") { _: List<String> ->
      // iOS-only: maps to preferredScreenEdgesDeferringSystemGestures.
      // Android has no equivalent — system gestures are user-configurable
      // at the OS level, not per-app.
    }

    // MARK: - MentraOS Notification Commands

    AsyncFunction("setNotificationConfig") {
      listenerEnabled: Boolean, notificationsEnabled: Boolean, blocklist: List<String> ->
      val context =
              appContext.reactContext
                      ?: appContext.currentActivity
                              ?: throw IllegalStateException("No context available")
      NotificationListener.setNotificationConfig(
        context,
        listenerEnabled,
        notificationsEnabled,
        blocklist,
      )
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

    // MARK: - MentraJS Runtime

    AsyncFunction("mentraJsSpawn") { packageName: String, polyfillBundle: String, miniappJs: String ->
      val ctx =
              appContext.reactContext
                      ?: appContext.currentActivity
                              ?: throw IllegalStateException("MentraJS: no context")
      // Safety net for the OnCreate-too-early race: if the runtime wasn't
      // wired during module creation (no reactContext yet), do it now —
      // otherwise every host-bound __dispatch from this miniapp's JSContext
      // would have a null onOutbound sink and silently drop frames.
      installRuntimeIfPossible("mentraJsSpawn")
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

    Function("mentraJsAlivePackages") {
      val ctx =
              appContext.reactContext
                      ?: appContext.currentActivity
      if (ctx == null) {
        return@Function emptyList<String>()
      }
      JSCRuntime.shared(ctx).alivePackages()
    }

    AsyncFunction("mentraJsDebugForceGC") { packageName: String ->
      val ctx =
              appContext.reactContext
                      ?: appContext.currentActivity
                              ?: return@AsyncFunction false
      JSCRuntime.shared(ctx).debugForceGC(packageName)
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

    AsyncFunction("saveToGalleryWithDate") {
            filePath: String,
            captureTimeMillis: Long?,
            displayName: String?
      ->
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

        val mediaDisplayName =
                displayName?.takeIf { it.isNotBlank() }
                        ?: run {
                          val parentName = file.parentFile?.name
                          if (parentName != null &&
                                          (parentName.startsWith("IMG_") ||
                                                  parentName.startsWith("VID_")) &&
                                          (file.name == "base.jpg" || file.name == "base.mp4")
                          ) {
                            val ext = if (mimeType.startsWith("video/")) "mp4" else "jpg"
                            "$parentName.$ext"
                          } else {
                            file.name
                          }
                        }

        val relativePath =
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                  if (isVideo) "Movies/Mentra" else "Pictures/Mentra"
                } else {
                  null
                }
        val resolver = context.contentResolver
        val stableDisplayName =
                mediaDisplayName.takeIf {
                  it.startsWith("IMG_") || it.startsWith("VID_")
                }
        val existingUri =
                stableDisplayName?.let {
                  findExistingGalleryAsset(
                          resolver,
                          collection,
                          listOf(it),
                          file.length(),
                          captureTimeMillis,
                          relativePath,
                          context.packageName,
                          requireUniqueMatch = false,
                  )
                }
                        ?: findExistingGalleryAsset(
                                resolver,
                                collection,
                                listOfNotNull(
                                                mediaDisplayName.takeIf { stableDisplayName == null },
                                                file.name.takeIf {
                                                  it.isNotBlank() && it != stableDisplayName
                                                },
                                        )
                                        .distinct(),
                                file.length(),
                                captureTimeMillis,
                                relativePath,
                                context.packageName,
                                requireUniqueMatch = true,
                        )
        if (existingUri != null) {
          android.util.Log.d("CrustModule", "Reusing existing gallery asset")
          return@AsyncFunction mapOf(
                  "success" to true,
                  "uri" to existingUri.toString(),
                  "existing" to true,
          )
        }

        val values =
                android.content.ContentValues().apply {
                  put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, mediaDisplayName)
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

                  if (relativePath != null) {
                    put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
                    put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1)
                  }
                }

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
                  "Successfully saved to gallery with proper DATE_TAKEN: $mediaDisplayName"
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
      val speed = (options?.get("speedMultiplier") as? Number)?.toFloat() ?: 1f
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
              "instruction" to payload.instruction,
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

    // Dev-only: clear the cached "terms accepted" flags (SDK + on-disk
    // pref + in-process) so the next requestNavigationPermission() call
    // re-shows the dialog. Used by the dev-settings re-trigger button.
    AsyncFunction("resetNavigationPermission") { promise: expo.modules.kotlin.Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(mapOf("ok" to false, "error" to "no current activity"))
        return@AsyncFunction
      }
      activity.runOnUiThread {
        try {
          NavigationManager.resetTermsAccepted(activity)
          promise.resolve(mapOf("ok" to true))
        } catch (e: Exception) {
          android.util.Log.e("CrustModule", "resetNavigationPermission failed", e)
          promise.resolve(mapOf("ok" to false, "error" to (e.message ?: "reset failed")))
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

  /**
   * Find a completed export from a previous attempt. A crash can happen after MediaStore commits
   * but before JavaScript persists the URI receipt; the stable capture display name, size, and
   * capture time, and Mentra album path let the retry return that receipt instead of inserting a
   * duplicate. Scoping by album is also important before deleting interrupted pending rows: a
   * same-named asset owned by another album must never be treated as ours.
   */
  private fun findExistingGalleryAsset(
          resolver: android.content.ContentResolver,
          collection: android.net.Uri,
          displayNames: List<String>,
          size: Long,
          captureTimeMillis: Long?,
          relativePath: String?,
          ownerPackageName: String,
          requireUniqueMatch: Boolean,
  ): android.net.Uri? {
    val dateColumn = android.provider.MediaStore.Images.ImageColumns.DATE_TAKEN
    if (displayNames.isEmpty()) return null
    val namePlaceholders = displayNames.joinToString(",") { "?" }
    val selectionParts =
            mutableListOf(
                    "${android.provider.MediaStore.MediaColumns.DISPLAY_NAME} IN ($namePlaceholders)",
            )
    val selectionArgs = displayNames.toMutableList()
    if (captureTimeMillis != null) {
      selectionParts.add("$dateColumn = ?")
      selectionArgs.add(captureTimeMillis.toString())
    }
    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q &&
                    relativePath != null
    ) {
      val pathWithoutTrailingSlash = relativePath.trimEnd('/')
      selectionParts.add(
              "(${android.provider.MediaStore.MediaColumns.RELATIVE_PATH} = ? OR " +
                      "${android.provider.MediaStore.MediaColumns.RELATIVE_PATH} = ?)"
      )
      // MediaProvider normally canonicalizes RELATIVE_PATH with a trailing slash. Accept the
      // caller's original representation too so exports created by older Android builds remain
      // reconcilable, while still requiring an exact Mentra album match.
      selectionArgs.add(pathWithoutTrailingSlash)
      selectionArgs.add("$pathWithoutTrailingSlash/")
      // Never reconcile or delete another application's pending MediaStore row.
      selectionParts.add("${android.provider.MediaStore.MediaColumns.OWNER_PACKAGE_NAME} = ?")
      selectionArgs.add(ownerPackageName)
    }
    val projection =
            mutableListOf(
                            android.provider.BaseColumns._ID,
                            android.provider.MediaStore.MediaColumns.SIZE,
                    )
                    .apply {
              if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                add(android.provider.MediaStore.MediaColumns.IS_PENDING)
              }
            }

    return try {
      resolver
              .query(
                      collection,
                      projection.toTypedArray(),
                      selectionParts.joinToString(" AND "),
                      selectionArgs.toTypedArray(),
                      "${android.provider.BaseColumns._ID} DESC",
              )
              ?.use { cursor ->
                val candidates = mutableListOf<android.net.Uri>()
                val idColumn = cursor.getColumnIndexOrThrow(android.provider.BaseColumns._ID)
                val sizeColumn =
                        cursor.getColumnIndexOrThrow(android.provider.MediaStore.MediaColumns.SIZE)
                val pendingColumn =
                        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                          cursor.getColumnIndex(android.provider.MediaStore.MediaColumns.IS_PENDING)
                        } else {
                          -1
                        }
                while (cursor.moveToNext()) {
                  val uri =
                          android.content.ContentUris.withAppendedId(
                                  collection,
                                  cursor.getLong(idColumn),
                          )
                  if (pendingColumn >= 0 && cursor.getInt(pendingColumn) != 0) {
                    // This app owns the row and it was never published. Remove the interrupted
                    // placeholder before retrying the copy, even if it contains only a prefix.
                    resolver.delete(uri, null, null)
                    continue
                  }
                  if (cursor.getLong(sizeColumn) == size) candidates.add(uri)
                }
                if (requireUniqueMatch) {
                  // A legacy `base.jpg`/`base.mp4` match is safe only when the complete
                  // name/date/size/path/owner fingerprint identifies exactly one asset.
                  candidates.singleOrNull()
                } else {
                  // Capture-derived display names are stable. If an older retry already made
                  // duplicates, reuse the newest completed row instead of creating another.
                  candidates.firstOrNull()
                }
              }
    } catch (error: Exception) {
      android.util.Log.w("CrustModule", "Unable to reconcile existing gallery asset", error)
      null
    }
  }
}
