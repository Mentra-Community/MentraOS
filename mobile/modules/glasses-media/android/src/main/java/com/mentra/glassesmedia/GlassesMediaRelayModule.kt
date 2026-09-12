package com.mentra.glassesmedia

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import com.mentra.glassesmedia.network.*
import com.mentra.glassesmedia.publisher.PhoneWhipPublisher
import com.mentra.glassesmedia.source.*
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors

/** Native resources for one coordinator-owned relay attempt. All transitions use one executor. */
class GlassesMediaRelayModule : Module() {
  private val worker = Executors.newSingleThreadExecutor()
  private var activeId: String? = null
  private var network: ScopedSoftApNetwork? = null
  private var internet: InternetHold? = null
  private var source: LocalWhipIngestSource? = null
  private var publisher: PhoneWhipPublisher? = null
  private var wakeLock: PowerManager.WakeLock? = null

  override fun definition() = ModuleDefinition {
    Name("MentraGlassesMediaRelay")
    Events("onRelayState")

    AsyncFunction("prepare") { options: Map<String, Any?>, promise: Promise ->
      worker.execute {
        try {
          check(activeId == null) { "Previous relay has not stopped" }
          val id = requireNotNull(options["attemptId"] as? String)
          val endpoint = requireNotNull(options["ingestUrl"] as? String)
          val ssid = requireNotNull(options["ssid"] as? String)
          val password = requireNotNull(options["password"] as? String)
          val context = requireNotNull(appContext.reactContext).applicationContext
          activeId = id
          val hold = InternetHold(context).also { internet = it }
          check(hold.awaitValidatedCellular().validated) { "Turn on phone mobile data to stream through the glasses hotspot" }
          val scoped = ScopedSoftApNetwork(context).also { network = it }
          if (!scoped.isWifiEnabled()) {
            Handler(Looper.getMainLooper()).post {
              appContext.currentActivity?.startActivity(Intent(Settings.Panel.ACTION_WIFI))
            }
            check(scoped.awaitWifiEnabled()) { "Phone Wi-Fi is disabled" }
            Thread.sleep(ScopedSoftApNetwork.WIFI_ENABLE_SETTLE_MS)
          }
          scoped.join(ssid, password, object : ScopedSoftApNetwork.Listener {
            override fun onAvailable(network: android.net.Network, localIpv4: String) = Unit
            override fun onLost(error: ScopedNetworkError) { emit(id, "failed", "Glasses hotspot connection was lost") }
          })
          ScopedNetworkChangeDetector.setRelayNetwork(scoped)
          val outgoing = PhoneWhipPublisher(context, endpoint, options["captureAudio"] != false,
            (options["bitrate"] as? Number)?.toInt() ?: 2_000_000) { state, reason -> emit(id, state, reason) }
          publisher = outgoing
          val incoming = LocalWhipIngestSource(context, VideoFrameListener(outgoing::onVideoFrame),
            PcmListener(outgoing::onPcm), scopedNetwork = scoped)
          source = incoming
          incoming.setStateListener { state, reason ->
            if (state == SourceState.FAILED) emit(id, "failed", "Glasses receiver: $reason")
          }
          incoming.setPcmDeliveryEnabled(options["captureAudio"] != false)
          incoming.start(SourceConfig("", SourceKind.SOFTAP, scoped.localIpv4()))
          wakeLock = context.getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Mentra:managed-relay").apply { acquire() }
          outgoing.start()
          promise.resolve(requireNotNull(incoming.ingestUrl))
        } catch (error: Exception) {
          // The owner still calls stop: preserve ownership until every acquired resource is gone.
          promise.reject("RELAY_PREPARE_FAILED", error.message, error)
        }
      }
    }

    AsyncFunction("stop") { attemptId: String, promise: Promise ->
      worker.execute {
        try {
          if (activeId == attemptId) cleanup()
          promise.resolve(null)
        } catch (error: Exception) { promise.reject("RELAY_STOP_FAILED", error.message, error) }
      }
    }

    OnDestroy { worker.execute { runCatching { cleanup() }; worker.shutdown() } }
  }

  private fun emit(id: String, state: String, reason: String) {
    sendEvent("onRelayState", mapOf("attemptId" to id, "state" to state, "reason" to reason))
  }

  private fun cleanup() {
    source?.setStateListener(null)
    // Try every cleanup even if one fails. Keep the slot occupied on any failure.
    var failure: Exception? = null
    fun step(action: () -> Unit) { try { action() } catch (e: Exception) { failure = failure ?: e } }
    step { source?.stop(); source = null }
    step { publisher?.close(); publisher = null }
    step { network?.release(); network = null; ScopedNetworkChangeDetector.setRelayNetwork(null) }
    step { internet?.close(); internet = null }
    step { wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null }
    failure?.let { throw it }
    activeId = null
  }
}
