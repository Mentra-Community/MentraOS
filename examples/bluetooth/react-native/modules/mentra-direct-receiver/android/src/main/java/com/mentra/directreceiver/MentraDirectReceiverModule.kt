package com.mentra.directreceiver

import android.content.Context
import android.net.Uri
import com.mentra.examples.android.media.GStreamerWhipReceiver
import com.mentra.examples.android.media.LocalPhotoUploadServer
import com.mentra.examples.android.media.PhotoUpload
import com.mentra.examples.android.media.WhipHeaderProxy
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address
import java.net.NetworkInterface

class MentraDirectReceiverModule : Module() {
  private var photoUploadServer: LocalPhotoUploadServer? = null
  private var whipReceiver: GStreamerWhipReceiver? = null
  private var whipProxy: WhipHeaderProxy? = null
  private var firstFrameSeen = false

  override fun definition() = ModuleDefinition {
    Name("MentraDirectReceiver")

    Events("photoUpload", "receiverStatus", "streamFirstFrame")

    AsyncFunction("isSupported") {
      true
    }

    AsyncFunction("startPhotoReceiver") {
      startPhotoReceiver()
    }

    AsyncFunction("stopPhotoReceiver") {
      stopPhotoReceiverInternal()
    }

    AsyncFunction("startWebRtcReceiver") {
      startWebRtcReceiver()
    }

    AsyncFunction("stopWebRtcReceiver") {
      stopWebRtcReceiverInternal()
    }

    OnDestroy {
      stopPhotoReceiverInternal()
      stopWebRtcReceiverInternal()
    }

    View(MentraDirectReceiverView::class) {
      OnViewDestroys { view: MentraDirectReceiverView ->
        DirectReceiverFrameRegistry.unregister(view)
      }
    }
  }

  private fun startPhotoReceiver(): Map<String, Any> {
    val host = bestLocalIpv4Address()
      ?: throw IllegalStateException("No Wi-Fi/LAN IPv4 address found for this phone.")
    val server = photoUploadServer ?: LocalPhotoUploadServer(
      context = reactContext(),
      onLog = { message -> emitStatus("photo", message) },
      onUpload = ::handlePhotoUpload,
    ).also {
      photoUploadServer = it
    }

    var lastError: Throwable? = null
    for (port in PHOTO_PORTS) {
      try {
        val actualPort = server.start(port)
        val uploadUrl = "http://$host:$actualPort/upload"
        emitStatus("photo", "Photo receiver ready at $uploadUrl")
        return mapOf(
          "uploadUrl" to uploadUrl,
          "host" to host,
          "port" to actualPort,
        )
      } catch (error: Throwable) {
        lastError = error
        emitStatus("photo", "Port $port unavailable: ${error.message ?: error::class.java.simpleName}")
      }
    }

    throw IllegalStateException(
      "Could not start phone photo receiver: ${lastError?.message ?: "all ports unavailable"}",
    )
  }

  private fun stopPhotoReceiverInternal() {
    photoUploadServer?.stop()
    emitStatus("photo", "Photo receiver stopped")
  }

  private fun handlePhotoUpload(upload: PhotoUpload) {
    val fileUri = Uri.fromFile(upload.photoFile).toString()
    sendEvent(
      "photoUpload",
      mapOf(
        "requestId" to upload.requestId,
        "fileUri" to fileUri,
        "byteCount" to upload.byteCount,
      ),
    )
    emitStatus("photo", "Photo uploaded (${upload.byteCount} bytes)")
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
            DirectReceiverFrameRegistry.update(bitmap)
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
    DirectReceiverFrameRegistry.clear()
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
    val PHOTO_PORTS = listOf(8787, 8788, 8789, 8790)
    val STREAM_PORT_PAIRS = listOf(
      8190 to 8191,
      8192 to 8193,
      8194 to 8195,
    )
  }
}
