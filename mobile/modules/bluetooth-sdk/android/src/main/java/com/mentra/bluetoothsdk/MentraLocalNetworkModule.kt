package com.mentra.bluetoothsdk

import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.util.Base64
import com.mentra.bluetoothsdk.hotspot.ScopedNetworkError
import com.mentra.bluetoothsdk.hotspot.ScopedSoftApNetwork
import com.mentra.bluetoothsdk.utils.NativeLog as Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * MentraOS-internal transport for glasses-local traffic without process network binding. Gallery
 * sync and hotspot OTA join through [ScopedSoftApNetwork], the same join Mentra Call and the
 * managed relay use, and send their HTTP over the `Network` it returns.
 */
class MentraLocalNetworkModule : Module() {
    private companion object {
        const val TAG = "MentraLocalNetwork"
    }

    private val lock = Any()
    private val executor = Executors.newCachedThreadPool()
    // Joins block, so they run one at a time off the JS thread. Disconnect does not queue
    // behind them: releasing the network ends a join in progress at once.
    private val joins = Executors.newSingleThreadExecutor()
    private val activeConnections = ConcurrentHashMap<String, HttpURLConnection>()
    private var scoped: ScopedSoftApNetwork? = null

    override fun definition() = ModuleDefinition {
        Name("MentraLocalNetwork")
        Events("downloadProgress", "networkLost")

        Function("getNetworkDiagnostics") {
            val manager = connectivityManager()
            // Sample time marks the beginning of these sequential local OS reads.
            val sampledAtMs = System.currentTimeMillis()
            networkDiagnostics(
                sampledAtMs,
                manager.boundNetworkForProcess,
                manager.activeNetwork,
                synchronized(lock) { scoped }?.network(),
            ) { network ->
                manager.getNetworkCapabilities(network)?.let { capabilities ->
                    mapOf(
                        "wifi" to capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
                        "cellular" to capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
                        "ethernet" to capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET),
                        "vpn" to capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN),
                        "internet" to capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
                        "validated" to capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
                        "captivePortal" to capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL),
                    )
                }
            }
        }

        AsyncFunction("connect") { ssid: String, password: String, incoming: Boolean, promise: Promise ->
            connect(ssid, password, incoming, promise)
        }

        AsyncFunction("request") {
            requestId: String,
            url: String,
            method: String,
            headers: Map<String, String>,
            body: String?,
            timeoutMs: Int,
            promise: Promise ->
            executor.execute { performRequest(requestId, url, method, headers, body, timeoutMs, promise) }
        }

        AsyncFunction("download") {
            requestId: String,
            url: String,
            destination: String,
            headers: Map<String, String>,
            connectionTimeoutMs: Int,
            readTimeoutMs: Int,
            promise: Promise ->
            executor.execute {
                performDownload(
                    requestId,
                    url,
                    destination,
                    headers,
                    connectionTimeoutMs,
                    readTimeoutMs,
                    promise,
                )
            }
        }

        AsyncFunction("cancel") { requestId: String -> cancel(requestId) }
        AsyncFunction("disconnect") { disconnect() }

        OnDestroy {
            disconnect()
            joins.shutdown()
        }
    }

    private fun connectivityManager(): ConnectivityManager =
        requireNotNull(appContext.reactContext?.getSystemService(ConnectivityManager::class.java)) {
            "ConnectivityManager is unavailable"
        }

    private fun connect(ssid: String, password: String, incoming: Boolean, promise: Promise) {
        joins.execute {
            disconnect()
            val context = appContext.reactContext?.applicationContext
            if (context == null) {
                promise.reject("ERR_LOCAL_WIFI_REQUEST", "No React context", null)
                return@execute
            }
            val network = ScopedSoftApNetwork(context)
            synchronized(lock) { scoped = network }
            val listener =
                object : ScopedSoftApNetwork.Listener {
                    override fun onAvailable(network: Network, localIpv4: String) = Unit

                    override fun onLost(error: ScopedNetworkError) {
                        if (synchronized(lock) { scoped !== network }) return
                        cancelAll()
                        sendEvent("networkLost", mapOf("ssid" to ssid))
                    }
                }
            try {
                network.join(ssid, password, listener, incoming)
                if (synchronized(lock) { scoped !== network }) {
                    network.release()
                    promise.reject("ERR_LOCAL_WIFI_CANCELLED", "Local WiFi connection cancelled", null)
                    return@execute
                }
                Log.i(TAG, "Glasses WiFi network=${network.network()} is ready")
                promise.resolve(
                    buildMap<String, Any> {
                        put("connected", true)
                        put("ssid", ssid)
                        network.localIpv4()?.let { put("localAddress", it) }
                    },
                )
            } catch (error: Exception) {
                val cancelled = synchronized(lock) { (scoped !== network).also { if (!it) scoped = null } }
                if (cancelled) {
                    promise.reject("ERR_LOCAL_WIFI_CANCELLED", "Local WiFi connection cancelled", error)
                } else {
                    network.release()
                    val code = (error as? ScopedNetworkError)?.code ?: "ERR_LOCAL_WIFI_REQUEST"
                    promise.reject(code, error.message ?: "Could not connect to $ssid", error)
                }
            }
        }
    }

    private fun performRequest(
        requestId: String,
        url: String,
        method: String,
        headers: Map<String, String>,
        body: String?,
        timeoutMs: Int,
        promise: Promise,
    ) {
        var connection: HttpURLConnection? = null
        try {
            connection = openConnection(requestId, url)
            connection.requestMethod = method
            connection.connectTimeout = timeoutMs
            connection.readTimeout = timeoutMs
            headers.forEach(connection::setRequestProperty)
            if (body != null) {
                connection.doOutput = true
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val bytes = stream?.use { it.readBytes() } ?: ByteArray(0)
            promise.resolve(
                mapOf(
                    "status" to status,
                    "headers" to responseHeaders(connection),
                    "bodyBase64" to Base64.encodeToString(bytes, Base64.NO_WRAP),
                ),
            )
        } catch (error: Exception) {
            promise.reject("ERR_LOCAL_HTTP", error.message ?: "Local HTTP request failed", error)
        } finally {
            activeConnections.remove(requestId)
            connection?.disconnect()
        }
    }

    private fun performDownload(
        requestId: String,
        url: String,
        destination: String,
        headers: Map<String, String>,
        connectionTimeoutMs: Int,
        readTimeoutMs: Int,
        promise: Promise,
    ) {
        var connection: HttpURLConnection? = null
        try {
            connection = openConnection(requestId, url)
            connection.requestMethod = "GET"
            connection.connectTimeout = connectionTimeoutMs
            connection.readTimeout = readTimeoutMs
            headers.forEach(connection::setRequestProperty)
            val status = connection.responseCode
            if (status !in 200..299) throw IllegalStateException("HTTP $status")
            val contentLength = connection.contentLengthLong
            val responseHeaders = responseHeaders(connection)

            // Match RNFS's begin callback contract before the first response byte. Gallery
            // resumable downloads need the real status and Content-Range to validate segments.
            sendEvent(
                "downloadProgress",
                mapOf(
                    "requestId" to requestId,
                    "bytesWritten" to 0L,
                    "contentLength" to contentLength,
                    "statusCode" to status,
                    "headers" to responseHeaders,
                ),
            )

            val destinationFile = File(destination)
            destinationFile.parentFile?.mkdirs()
            var bytesWritten = 0L
            connection.inputStream.use { input ->
                FileOutputStream(destinationFile, false).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        output.write(buffer, 0, count)
                        bytesWritten += count
                        sendEvent(
                            "downloadProgress",
                            mapOf(
                                "requestId" to requestId,
                                "bytesWritten" to bytesWritten,
                                "contentLength" to contentLength,
                            ),
                        )
                    }
                }
            }
            promise.resolve(
                mapOf(
                    "statusCode" to status,
                    "bytesWritten" to bytesWritten,
                    "headers" to responseHeaders,
                ),
            )
        } catch (error: Exception) {
            promise.reject("ERR_LOCAL_DOWNLOAD", error.message ?: "Local download failed", error)
        } finally {
            activeConnections.remove(requestId)
            connection?.disconnect()
        }
    }

    private fun openConnection(requestId: String, url: String): HttpURLConnection {
        val network = synchronized(lock) { scoped }?.network()
            ?: throw IllegalStateException("Local WiFi is not connected")
        val connection = network.openConnection(URL(url)) as HttpURLConnection
        activeConnections[requestId] = connection
        return connection
    }

    private fun responseHeaders(connection: HttpURLConnection): Map<String, String> =
        connection.headerFields
            .filterKeys { it != null }
            .mapValues { (_, values) -> values.joinToString(", ") }

    private fun cancel(requestId: String) {
        activeConnections.remove(requestId)?.disconnect()
    }

    private fun cancelAll() {
        activeConnections.keys.toList().forEach(::cancel)
    }

    private fun disconnect() {
        cancelAll()
        val network = synchronized(lock) { scoped.also { scoped = null } }
        network?.release()
    }
}
