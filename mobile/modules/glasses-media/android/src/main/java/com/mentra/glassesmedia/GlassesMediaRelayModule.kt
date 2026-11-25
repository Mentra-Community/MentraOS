package com.mentra.glassesmedia

import com.mentra.bluetoothsdk.hotspot.ScopedSoftApNetwork
import android.net.wifi.WifiManager
import android.os.Build
import android.os.PowerManager
import android.util.Base64
import com.mentra.glassesmedia.grab.StreamFrameGrab
import com.mentra.glassesmedia.trace.MediaLog
import com.mentra.glassesmedia.trace.MediaLog as Log
import com.mentra.glassesmedia.network.*
import com.mentra.glassesmedia.passthrough.PassthroughBridge
import com.mentra.glassesmedia.publisher.PhoneWhipPublisher
import com.mentra.glassesmedia.publisher.RelayPcmInput
import com.mentra.glassesmedia.source.*
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors

/**
 * Native resources for one coordinator-owned relay attempt, on the glasses network the glasses
 * Wi-Fi service joined. All transitions use one executor.
 */
class GlassesMediaRelayModule : Module() {
  private val worker = Executors.newSingleThreadExecutor()
  private var activeId: String? = null
  private var network: ScopedSoftApNetwork? = null
  private var source: LocalWhipIngestSource? = null
  private var publisher: PhoneWhipPublisher? = null
  private var wakeLock: PowerManager.WakeLock? = null
  /** Keeps the Wi-Fi radio out of power save while it carries the glasses' video. */
  private var wifiLock: WifiManager.WifiLock? = null
  private val pcmInput = RelayPcmInput()

  override fun definition() = ModuleDefinition {
    Name("MentraGlassesMediaRelay")
    Events("onRelayState", "onNativeLog")

    OnCreate { MediaLog.sink = { message -> sendEvent("onNativeLog", mapOf("message" to message)) } }

    AsyncFunction("prepare") { options: Map<String, Any?>, promise: Promise ->
      worker.execute {
        try {
          check(activeId == null) { "Previous relay has not stopped" }
          val id = requireNotNull(options["attemptId"] as? String)
          val endpoint = requireNotNull(options["ingestUrl"] as? String)
          val context = requireNotNull(appContext.reactContext).applicationContext
          activeId = id
          // The glasses network the glasses Wi-Fi service joined; the relay only borrows it.
          val scoped = ScopedSoftApNetwork.shared(context).also { network = it }
          check(scoped.isAvailable()) { "The phone is not on the glasses network" }
          ScopedNetworkChangeDetector.registerRelayNetwork(scoped)
          // Forward the glasses' encoded video untouched instead of decoding and encoding it again.
          // Only when the caller asked, so an old caller and every other stream keep the re-encode.
          val bridge = if (options["videoPassthrough"] == true) PassthroughBridge() else null
          val outgoing = PhoneWhipPublisher(context, endpoint, options["captureAudio"] != false,
            (options["bitrate"] as? Number)?.toInt() ?: 2_000_000, bridge) { state, reason -> emit(id, state, reason) }
          publisher = outgoing
          val bleAudio = options["captureAudio"] != false && options["audioTransport"] == "ble-lc3"
          if (bleAudio) pcmInput.attach(id, outgoing::onPcm)
          Log.i("ManagedRelay", "Audio transport=${options["audioTransport"] ?: "whip"} " +
            "video=${if (bridge != null) "passthrough" else "reencode"} attempt=$id")
          // Decoded frames go to the publisher, then to the phone's own preview of the stream.
          val incoming = LocalWhipIngestSource(context, relayFrameFanOut(VideoFrameListener(outgoing::onVideoFrame)),
            PcmListener(outgoing::onPcm), scopedNetwork = scoped, passthrough = bridge,
            encodedListener = bridge?.let { EncodedFrameListener(outgoing::onEncodedFrame) })
          source = incoming
          incoming.setStateListener { state, reason ->
            if (state == SourceState.FAILED) emit(id, "failed", "Glasses receiver: $reason")
          }
          incoming.setPcmDeliveryEnabled(options["captureAudio"] != false && !bleAudio)
          incoming.start(SourceConfig("", SourceKind.SOFTAP, scoped.localIpv4()))
          wakeLock = context.getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Mentra:managed-relay").apply { acquire() }
          wifiLock = context.getSystemService(WifiManager::class.java)?.createWifiLock(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            else @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF,
            "Mentra:managed-relay",
          )?.apply { setReferenceCounted(false); acquire() }
          outgoing.start()
          promise.resolve(requireNotNull(incoming.ingestUrl))
        } catch (error: Exception) {
          // The owner still calls stop: preserve ownership until every acquired resource is gone.
          promise.reject("RELAY_PREPARE_FAILED", error.message, error)
        }
      }
    }

    Function("pushOutgoingPcm") { attemptId: String, base64: String, sampleRate: Int, channels: Int ->
      val bytes = try { Base64.decode(base64, Base64.DEFAULT) } catch (_: IllegalArgumentException) { null }
      bytes != null && pcmInput.push(attemptId, bytes, sampleRate, channels)
    }

    // Milliseconds since this phone last decoded a glasses frame, or -1. Covers ACS calls too:
    // they decode through the same receivers.
    Function("streamFrameAgeMs") { -> StreamFrameGrab.frameAgeMs().toDouble() }

    AsyncFunction("grabStreamFrame") { options: Map<String, Any?>, promise: Promise ->
      val quality = ((options["quality"] as? Number)?.toInt() ?: 90).coerceIn(1, 100)
      val timeoutMs = ((options["timeoutMs"] as? Number)?.toLong() ?: 1_500L).coerceIn(100L, 5_000L)
      StreamFrameGrab.grab(quality, timeoutMs) { frame, reason ->
        if (frame == null) {
          promise.reject("STREAM_FRAME_UNAVAILABLE", reason ?: "unknown", null)
        } else {
          promise.resolve(
            mapOf(
              "base64" to Base64.encodeToString(frame.jpeg, Base64.NO_WRAP),
              "width" to frame.width,
              "height" to frame.height,
              "bytes" to frame.jpeg.size,
            ),
          )
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

    OnDestroy {
      MediaLog.sink = null
      worker.execute { runCatching { cleanup() }; worker.shutdown() }
    }
  }

  private fun emit(id: String, state: String, reason: String) {
    sendEvent("onRelayState", mapOf("attemptId" to id, "state" to state, "reason" to reason))
  }

  private fun cleanup() {
    pcmInput.detach()
    source?.setStateListener(null)
    // Try every cleanup even if one fails. Keep the slot occupied on any failure.
    var failure: Exception? = null
    fun step(action: () -> Unit) { try { action() } catch (e: Exception) { failure = failure ?: e } }
    step { source?.close(); source = null }
    step { publisher?.close(); publisher = null }
    step { network?.let { ScopedNetworkChangeDetector.releaseRelayNetwork(it) }; network = null }
    step { wakeLock?.let { if (it.isHeld) it.release() }; wakeLock = null }
    step { wifiLock?.let { if (it.isHeld) it.release() }; wifiLock = null }
    failure?.let { throw it }
    activeId = null
  }
}
