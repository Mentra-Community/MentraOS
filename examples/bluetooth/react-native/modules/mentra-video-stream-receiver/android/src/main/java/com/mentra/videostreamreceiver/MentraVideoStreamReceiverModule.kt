package com.mentra.videostreamreceiver

import android.content.Context
import com.mentra.examples.android.media.GStreamerWhipReceiver
import com.mentra.examples.android.media.WhipHeaderProxy
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address
import java.net.NetworkInterface

class MentraVideoStreamReceiverModule : Module() {
  private var whipReceiver: GStreamerWhipReceiver? = null
  private var whipProxy: WhipHeaderProxy? = null
  private var firstFrameSeen = false

  override fun definition() = ModuleDefinition {
    Name("MentraVideoStreamReceiver")

    Events("receiverStatus", "streamFirstFrame")

    AsyncFunction("isSupported") {
      true
    }

    AsyncFunction("startWebRtcReceiver") {
      startWebRtcReceiver()
    }

    AsyncFunction("stopWebRtcReceiver") {
      stopWebRtcReceiverInternal()
    }

    OnDestroy {
      stopWebRtcReceiverInternal()
    }

    View(MentraVideoStreamReceiverView::class) {
      OnViewDestroys { view: MentraVideoStreamReceiverView ->
        VideoStreamReceiverFrameRegistry.unregister(view)
      }
    }
  }

  private fun startWebRtcReceiver(): Map<String, Any> {
    val host = bestLocalIpv4Address()
      ?: throw IllegalStateException("No Wi-Fi/LAN IPv4 address found for this phone.")
    stopWebRtcReceiverInternal()

    var lastError: Throwable? = null
    for ((publicPort, backendPort) in STREAM_PORT_PAIRS) {
      try {
        val receiver = GStreamerWhipReceiver(
          context = reactContext(),
          onStatus = { message -> emitStatus("stream", message) },
          onFrame = { bitmap ->
            VideoStreamReceiverFrameRegistry.update(bitmap)
            if (!firstFrameSeen) {
              firstFrameSeen = true
              sendEvent("streamFirstFrame", mapOf("timestamp" to System.currentTimeMillis()))
            }
          },
        )
        val streamUrl = receiver.start(host, publicPort, backendPort)
        val proxy = WhipHeaderProxy { message -> emitStatus("whip", message) }
        proxy.start(publicPort, backendPort)
        whipReceiver = receiver
        whipProxy = proxy
        emitStatus("stream", "WebRTC phone receiver ready at $streamUrl")
        return mapOf(
          "streamUrl" to streamUrl,
          "host" to host,
          "publicPort" to publicPort,
          "backendPort" to backendPort,
        )
      } catch (error: Throwable) {
        lastError = error
        emitStatus(
          "stream",
          "Ports $publicPort/$backendPort unavailable: ${error.message ?: error::class.java.simpleName}",
        )
        stopWebRtcReceiverInternal()
      }
    }

    throw IllegalStateException(
      "Could not start phone WebRTC receiver: ${lastError?.message ?: "all ports unavailable"}",
    )
  }

  private fun stopWebRtcReceiverInternal() {
    try {
      whipProxy?.close()
    } catch (_: Throwable) {
    }
    whipProxy = null
    try {
      whipReceiver?.close()
    } catch (_: Throwable) {
    }
    whipReceiver = null
    firstFrameSeen = false
    VideoStreamReceiverFrameRegistry.clear()
    emitStatus("stream", "WebRTC phone receiver stopped")
  }

  private fun emitStatus(kind: String, message: String) {
    sendEvent(
      "receiverStatus",
      mapOf(
        "kind" to kind,
        "message" to message,
      ),
    )
  }

  private fun reactContext(): Context {
    return appContext.reactContext
      ?: appContext.currentActivity
      ?: throw Exceptions.ReactContextLost()
  }

  private fun bestLocalIpv4Address(): String? {
    val candidates = mutableListOf<Inet4Address>()
    val interfaces = NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
    for (networkInterface in interfaces) {
      if (!networkInterface.isUp || networkInterface.isLoopback) {
        continue
      }
      val addresses = networkInterface.inetAddresses.toList().filterIsInstance<Inet4Address>()
      candidates += addresses.filterNot { it.isLoopbackAddress || it.isLinkLocalAddress }
    }

    return candidates.firstOrNull { address ->
      val host = address.hostAddress.orEmpty()
      host.startsWith("192.168.") || host.startsWith("10.") || host.matches(Regex("^172\\.(1[6-9]|2[0-9]|3[0-1])\\..*"))
    }?.hostAddress ?: candidates.firstOrNull()?.hostAddress
  }

  private companion object {
    val STREAM_PORT_PAIRS = listOf(
      8190 to 8191,
      8192 to 8193,
      8194 to 8195,
    )
  }
}
