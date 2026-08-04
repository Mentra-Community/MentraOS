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
      closePhotoReceiverInternal()
    }
  }

  @Synchronized
  private fun startPhotoReceiver(): Map<String, Any> {
    val server = photoUploadServer ?: LocalPhotoUploadServer(
      context = reactContext(),
      onLog = { message -> emitStatus(message) },
      onUpload = ::handlePhotoUpload,
    ).also {
      photoUploadServer = it
    }

    val host = bestLocalIpv4Address()
      ?: throw IllegalStateException("No Wi-Fi/LAN IPv4 address found for this phone.")

    server.activePort?.let { activePort ->
      val endpoint = receiverEndpoint(host, activePort)
      LocalPhotoReceiverRegistry.register(endpoint.uploadUrl)
      emitStatus("Photo receiver ready at ${endpoint.uploadUrl}")
      return receiverResult(endpoint)
    }

    var lastError: Throwable? = null
    for (port in PHOTO_PORTS) {
      try {
        val actualPort = server.start(port)
        val endpoint = receiverEndpoint(host, actualPort)
        LocalPhotoReceiverRegistry.register(endpoint.uploadUrl)
        emitStatus("Photo receiver ready at ${endpoint.uploadUrl}")
        return receiverResult(endpoint)
      } catch (error: Throwable) {
        lastError = error
        emitStatus("Port $port unavailable: ${error.message ?: error::class.java.simpleName}")
      }
    }

    throw IllegalStateException(
      "Could not start phone photo receiver: ${lastError?.message ?: "all ports unavailable"}",
    )
  }

  @Synchronized
  private fun stopPhotoReceiverInternal() {
    photoUploadServer?.stop()
    LocalPhotoReceiverRegistry.unregister()
    emitStatus("Photo receiver stopped")
  }

  @Synchronized
  private fun closePhotoReceiverInternal() {
    photoUploadServer?.close()
    photoUploadServer = null
    LocalPhotoReceiverRegistry.unregister()
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
    val wifiPrivateCandidates = mutableListOf<Inet4Address>()
    val wifiCandidates = mutableListOf<Inet4Address>()
    val privateCandidates = mutableListOf<Inet4Address>()
    val otherCandidates = mutableListOf<Inet4Address>()
    val interfaces = NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
    for (networkInterface in interfaces) {
      if (!networkInterface.isUp || networkInterface.isLoopback) {
        continue
      }
      val addresses = networkInterface.inetAddresses.toList()
        .filterIsInstance<Inet4Address>()
        .filter { address ->
          !address.isLoopbackAddress &&
            !address.isLinkLocalAddress
        }
      if (isWifiInterface(networkInterface.name)) {
        wifiPrivateCandidates += addresses.filter { isPrivateIpv4(it.hostAddress.orEmpty()) }
        wifiCandidates += addresses
      } else {
        privateCandidates += addresses.filter { isPrivateIpv4(it.hostAddress.orEmpty()) }
        otherCandidates += addresses
      }
    }

    return (
      wifiPrivateCandidates.firstOrNull() ?:
        wifiCandidates.firstOrNull() ?:
        privateCandidates.firstOrNull() ?:
        otherCandidates.firstOrNull()
      )?.hostAddress
  }

  private fun receiverEndpoint(host: String, port: Int): ReceiverEndpoint {
    return ReceiverEndpoint(
      uploadUrl = "http://$host:$port/upload",
      host = host,
      port = port,
    )
  }

  private fun receiverResult(endpoint: ReceiverEndpoint): Map<String, Any> {
    return mapOf(
      "uploadUrl" to endpoint.uploadUrl,
      "host" to endpoint.host,
      "port" to endpoint.port,
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

  private data class ReceiverEndpoint(
    val uploadUrl: String,
    val host: String,
    val port: Int,
  )
}
