package com.mentra.bluetoothsdk.otaserver

import android.os.Build
import android.util.Log
import com.mentra.bluetoothsdk.net.LocalIpv4
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Expo surface for the hotspot-served OTA file server (OS-1676).
 *
 * JS hands over the rewritten manifest body and a map of sha256 -> local file path, and gets
 * back the base URL the glasses should be pointed at via ota_start. The optional host
 * argument lets the caller pass the authoritative scoped-network address (from
 * MentraLocalNetwork's LinkProperties); otherwise interface scanning is used.
 */
class MentraOtaServerModule : Module() {
  private var otaServer: LocalOtaServer? = null
  private val keepaliveExecutor = Executors.newSingleThreadScheduledExecutor()
  private var keepaliveFuture: ScheduledFuture<*>? = null

  override fun definition() = ModuleDefinition {
    Name("MentraOtaServer")

    Events("serverStatus")

    AsyncFunction("isSupported") {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
    }

    AsyncFunction("startOtaServer") { manifestJson: String, artifactPaths: Map<String, String>, host: String? ->
      startOtaServer(manifestJson, artifactPaths, host)
    }

    AsyncFunction("stopOtaServer") {
      stopOtaServerInternal()
    }

    AsyncFunction("startHealthKeepalive") { url: String, intervalMs: Int ->
      startHealthKeepalive(url, intervalMs)
    }

    AsyncFunction("stopHealthKeepalive") {
      stopHealthKeepaliveInternal()
    }

    OnDestroy {
      stopHealthKeepaliveInternal()
      closeOtaServerInternal()
      keepaliveExecutor.shutdownNow()
    }
  }

  @Synchronized
  private fun startOtaServer(
    manifestJson: String,
    artifactPaths: Map<String, String>,
    hostOverride: String?,
  ): Map<String, Any> {
    val artifacts = artifactPaths.mapValues { (_, path) ->
      File(path.removePrefix("file://"))
    }
    artifacts.forEach { (key, file) ->
      if (!file.isFile) {
        throw IllegalArgumentException("Artifact $key not found at ${file.absolutePath}")
      }
    }

    val server = otaServer ?: LocalOtaServer(
      onLog = { message -> emitStatus(message) },
    ).also {
      otaServer = it
    }
    server.configure(manifestJson, artifacts)

    val host = hostOverride?.takeIf { it.isNotBlank() }
      ?: LocalIpv4.bestLocalIpv4Address()
      ?: throw IllegalStateException("No Wi-Fi/LAN IPv4 address found for this phone.")

    server.activePort?.let { activePort ->
      emitStatus("OTA server ready at http://$host:$activePort/version.json")
      return serverResult(host, activePort)
    }

    var lastError: Throwable? = null
    for (port in OTA_PORTS) {
      try {
        val actualPort = server.start(host, port)
        emitStatus("OTA server ready at http://$host:$actualPort/version.json")
        return serverResult(host, actualPort)
      } catch (error: Throwable) {
        lastError = error
        emitStatus("Port $port unavailable: ${error.message ?: error::class.java.simpleName}")
      }
    }

    throw IllegalStateException(
      "Could not start OTA server: ${lastError?.message ?: "all ports unavailable"}",
    )
  }

  @Synchronized
  private fun stopOtaServerInternal() {
    otaServer?.stop()
    emitStatus("OTA server stopped")
  }

  @Synchronized
  private fun startHealthKeepalive(url: String, intervalMs: Int) {
    require(url.startsWith("http://") || url.startsWith("https://")) { "Invalid health URL" }
    stopHealthKeepaliveInternal()
    val cadence = intervalMs.coerceAtLeast(5_000).toLong()
    keepaliveFuture = keepaliveExecutor.scheduleWithFixedDelay(
      {
        var connection: HttpURLConnection? = null
        try {
          connection = URL(url).openConnection() as HttpURLConnection
          connection.requestMethod = "HEAD"
          connection.connectTimeout = 5_000
          connection.readTimeout = 5_000
          val status = connection.responseCode
          emitStatus("Glasses health keepalive HTTP $status")
        } catch (error: Throwable) {
          emitStatus("Glasses health keepalive failed: ${error.message ?: error::class.java.simpleName}")
        } finally {
          connection?.disconnect()
        }
      },
      0,
      cadence,
      TimeUnit.MILLISECONDS,
    )
  }

  @Synchronized
  private fun stopHealthKeepaliveInternal() {
    keepaliveFuture?.cancel(true)
    keepaliveFuture = null
  }

  @Synchronized
  private fun closeOtaServerInternal() {
    otaServer?.close()
    otaServer = null
  }

  private fun emitStatus(message: String) {
    Log.d(TAG, message)
    sendEvent(
      "serverStatus",
      mapOf("message" to message),
    )
  }

  private fun serverResult(host: String, port: Int): Map<String, Any> {
    return mapOf(
      "baseUrl" to "http://$host:$port",
      "manifestUrl" to "http://$host:$port/version.json",
      "host" to host,
      "port" to port,
    )
  }

  private companion object {
    const val TAG = "MentraOtaServer"
    val OTA_PORTS = listOf(8791, 8792, 8793, 8794)
  }
}
