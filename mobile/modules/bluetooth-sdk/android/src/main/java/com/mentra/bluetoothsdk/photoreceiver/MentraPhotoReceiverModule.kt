package com.mentra.bluetoothsdk.photoreceiver

import android.content.Context
import android.net.Uri
import android.util.Log
import com.mentra.bluetoothsdk.debug.BleTraceLogger
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

    server.activePort?.let { activePort ->
      val uploadUrl = "http://$host:$activePort/upload"
      emitStatus("Photo receiver ready at $uploadUrl")
      return receiverResult(uploadUrl, host, activePort)
    }

    var lastError: Throwable? = null
    for (port in PHOTO_PORTS) {
      try {
        val actualPort = server.start(port)
        val uploadUrl = "http://$host:$actualPort/upload"
        emitStatus("Photo receiver ready at $uploadUrl")
        return receiverResult(uploadUrl, host, actualPort)
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
    try {
      BleTraceLogger.logMap(
        "phone_to_app",
        "photo_receiver_event",
        "photo_upload",
        mapOf(
          "requestId" to upload.requestId.orEmpty(),
          "fileName" to upload.photoFile.name,
          "byteCount" to upload.byteCount,
        ),
      )
    } catch (_: Throwable) {
    }
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
    Log.d(TAG, message)
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
    val wifiCandidates = mutableListOf<Inet4Address>()
    val privateCandidates = mutableListOf<Inet4Address>()
    val interfaces = NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
    for (networkInterface in interfaces) {
      if (!networkInterface.isUp || networkInterface.isLoopback) {
        continue
      }
      val addresses = networkInterface.inetAddresses.toList()
        .filterIsInstance<Inet4Address>()
        .filter { address ->
          !address.isLoopbackAddress &&
            !address.isLinkLocalAddress &&
            isPrivateIpv4(address.hostAddress.orEmpty())
        }
      if (isWifiInterface(networkInterface.name)) {
        wifiCandidates += addresses
      } else {
        privateCandidates += addresses
      }
    }

    return (wifiCandidates.firstOrNull() ?: privateCandidates.firstOrNull())?.hostAddress
  }

  private fun receiverResult(uploadUrl: String, host: String, port: Int): Map<String, Any> {
    return mapOf(
      "uploadUrl" to uploadUrl,
      "host" to host,
      "port" to port,
    )
  }

  private fun isWifiInterface(name: String): Boolean {
    return name.startsWith("wlan") ||
      name.startsWith("p2p") ||
      name.startsWith("ap") ||
      name.startsWith("swlan")
  }

  private fun isPrivateIpv4(host: String): Boolean {
    return host.startsWith("192.168.") ||
      host.startsWith("10.") ||
      host.matches(Regex("^172\\.(1[6-9]|2[0-9]|3[0-1])\\..*"))
  }

  private companion object {
    const val TAG = "MentraPhotoReceiver"
    val PHOTO_PORTS = listOf(8787, 8788, 8789, 8790)
  }
}
