package com.mentra.photoreceiver

import android.content.Context
import android.net.Uri
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet4Address
import java.net.NetworkInterface

class MentraPhotoReceiverModule : Module() {
  private var photoUploadServer: LocalPhotoUploadServer? = null

  override fun definition() = ModuleDefinition {
    Name("MentraPhotoReceiver")

    Events("photoUpload", "receiverStatus")

    AsyncFunction("isSupported") {
      true
    }

    AsyncFunction("startPhotoReceiver") {
      startPhotoReceiver()
    }

    AsyncFunction("stopPhotoReceiver") {
      stopPhotoReceiverInternal()
    }

    OnDestroy {
      stopPhotoReceiverInternal()
    }
  }

  private fun startPhotoReceiver(): Map<String, Any> {
    val host = bestLocalIpv4Address()
      ?: throw IllegalStateException("No Wi-Fi/LAN IPv4 address found for this phone.")
    val server = photoUploadServer ?: LocalPhotoUploadServer(
      context = reactContext(),
      onLog = { message -> emitStatus(message) },
      onUpload = ::handlePhotoUpload,
    ).also {
      photoUploadServer = it
    }

    var lastError: Throwable? = null
    for (port in PHOTO_PORTS) {
      try {
        val actualPort = server.start(port)
        val uploadUrl = "http://$host:$actualPort/upload"
        emitStatus("Photo receiver ready at $uploadUrl")
        return mapOf(
          "uploadUrl" to uploadUrl,
          "host" to host,
          "port" to actualPort,
        )
      } catch (error: Throwable) {
        lastError = error
        emitStatus("Port $port unavailable: ${error.message ?: error::class.java.simpleName}")
      }
    }

    throw IllegalStateException(
      "Could not start phone photo receiver: ${lastError?.message ?: "all ports unavailable"}",
    )
  }

  private fun stopPhotoReceiverInternal() {
    photoUploadServer?.stop()
    emitStatus("Photo receiver stopped")
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
    emitStatus("Photo uploaded (${upload.byteCount} bytes)")
  }

  private fun emitStatus(message: String) {
    sendEvent(
      "receiverStatus",
      mapOf("message" to message),
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
  }
}
