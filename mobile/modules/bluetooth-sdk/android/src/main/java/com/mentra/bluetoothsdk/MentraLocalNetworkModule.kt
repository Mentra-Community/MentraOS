package com.mentra.bluetoothsdk

import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** MentraOS-internal transport for glasses-local traffic without process network binding. */
class MentraLocalNetworkModule : Module() {
    private companion object {
        const val TAG = "MentraLocalNetwork"
        const val NETWORK_READINESS_TIMEOUT_MS = 5_000L
    }

    private val lock = Any()
    private val executor = Executors.newCachedThreadPool()
    private val handler = Handler(Looper.getMainLooper())
    private val activeConnections = ConcurrentHashMap<String, HttpURLConnection>()
    private val networkReadiness = ScopedNetworkReadiness<Network>()
    private var localNetwork: Network? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var pendingConnectPromise: Promise? = null
    private var pendingReadinessTimeout: Runnable? = null

    override fun definition() = ModuleDefinition {
        Name("MentraLocalNetwork")
        Events("downloadProgress", "networkLost")

        AsyncFunction("connect") { ssid: String, password: String, promise: Promise ->
            connect(ssid, password, promise)
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
        }
    }

    private fun connectivityManager(): ConnectivityManager =
        requireNotNull(appContext.reactContext?.getSystemService(ConnectivityManager::class.java)) {
            "ConnectivityManager is unavailable"
        }

    private fun connect(ssid: String, password: String, promise: Promise) {
        disconnect()
        val manager = connectivityManager()
        val specifier =
            WifiNetworkSpecifier.Builder()
                .setSsid(ssid)
                .setWpa2Passphrase(password)
                .build()
        val request =
            NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .setNetworkSpecifier(specifier)
                .build()

        val callback =
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    synchronized(lock) {
                        if (networkCallback !== this) {
                            Log.d(TAG, "Ignoring onAvailable from a stale network request")
                            return
                        }
                        networkReadiness.onAvailable(network)
                    }
                    Log.i(
                        TAG,
                        "Captured glasses WiFi network=$network; waiting for foreground capability " +
                            "processBoundNetwork=${manager.boundNetworkForProcess}",
                    )
                    scheduleReadinessTimeout(this, ssid)
                }

                override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                    val connectPromise: Promise?
                    synchronized(lock) {
                        if (networkCallback !== this || localNetwork != null || pendingConnectPromise == null) return
                        if (!networkReadiness.isReady(
                                network,
                                capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_FOREGROUND),
                            )
                        ) {
                            return
                        }
                        localNetwork = network
                        connectPromise = pendingConnectPromise
                        pendingConnectPromise = null
                        cancelReadinessTimeoutLocked()
                    }
                    Log.i(
                        TAG,
                        "Glasses WiFi network=$network is foreground and ready " +
                            "processBoundNetwork=${manager.boundNetworkForProcess}",
                    )
                    val localAddress =
                        manager.getLinkProperties(network)
                            ?.linkAddresses
                            ?.firstOrNull { it.address is Inet4Address }
                            ?.address
                            ?.hostAddress
                    connectPromise?.resolve(
                        buildMap<String, Any> {
                            put("connected", true)
                            put("ssid", ssid)
                            if (!localAddress.isNullOrBlank()) put("localAddress", localAddress)
                        },
                    )
                }

                override fun onUnavailable() {
                    synchronized(lock) {
                        if (networkCallback !== this) {
                            Log.d(TAG, "Ignoring onUnavailable from a stale network request")
                            return
                        }
                    }
                    rejectPendingConnect("ERR_LOCAL_WIFI_UNAVAILABLE", "Could not connect to $ssid")
                    clearNetworkCallback(this)
                }

                override fun onLost(network: Network) {
                    synchronized(lock) {
                        if (networkCallback !== this ||
                            (localNetwork != network && !networkReadiness.contains(network))
                        ) {
                            Log.d(TAG, "Ignoring onLost from a stale network request")
                            return
                        }
                        localNetwork = null
                        networkReadiness.clear()
                    }
                    cancelAll()
                    rejectPendingConnect("ERR_LOCAL_WIFI_LOST", "Lost connection to $ssid")
                    clearNetworkCallback(this)
                    sendEvent("networkLost", mapOf("ssid" to ssid))
                }
            }

        synchronized(lock) {
            pendingConnectPromise = promise
            networkCallback = callback
        }
        try {
            manager.requestNetwork(request, callback, 30_000)
        } catch (error: Exception) {
            clearNetworkCallback(callback)
            rejectPendingConnect("ERR_LOCAL_WIFI_REQUEST", error.message ?: "Local WiFi request failed", error)
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
        val network = synchronized(lock) { localNetwork }
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

    private fun scheduleReadinessTimeout(
        callback: ConnectivityManager.NetworkCallback,
        ssid: String,
    ) {
        val timeout =
            Runnable {
                val connectPromise = synchronized(lock) {
                    if (networkCallback !== callback || pendingConnectPromise == null) return@Runnable
                    pendingReadinessTimeout = null
                    val promise = pendingConnectPromise
                    pendingConnectPromise = null
                    promise
                }
                connectPromise?.reject(
                    "ERR_LOCAL_WIFI_NOT_READY",
                    "Connected to $ssid but the network did not become ready",
                    null,
                )
                clearNetworkCallback(callback)
            }
        synchronized(lock) {
            if (networkCallback !== callback || pendingConnectPromise == null) return
            cancelReadinessTimeoutLocked()
            pendingReadinessTimeout = timeout
        }
        handler.postDelayed(timeout, NETWORK_READINESS_TIMEOUT_MS)
    }

    private fun cancelReadinessTimeoutLocked() {
        pendingReadinessTimeout?.let(handler::removeCallbacks)
        pendingReadinessTimeout = null
    }

    private fun disconnect() {
        cancelAll()
        val manager = appContext.reactContext?.getSystemService(ConnectivityManager::class.java)
        val callback: ConnectivityManager.NetworkCallback?
        synchronized(lock) {
            callback = networkCallback
            networkCallback = null
            localNetwork = null
            networkReadiness.clear()
            cancelReadinessTimeoutLocked()
        }
        if (callback != null && manager != null) {
            try {
                manager.unregisterNetworkCallback(callback)
            } catch (_: IllegalArgumentException) {
                // Already unregistered by the platform.
            }
        }
        rejectPendingConnect("ERR_LOCAL_WIFI_CANCELLED", "Local WiFi connection cancelled")
    }

    private fun clearNetworkCallback(callback: ConnectivityManager.NetworkCallback) {
        val manager = appContext.reactContext?.getSystemService(ConnectivityManager::class.java)
        synchronized(lock) {
            if (networkCallback == callback) {
                networkCallback = null
                localNetwork = null
                networkReadiness.clear()
                cancelReadinessTimeoutLocked()
            }
        }
        if (manager != null) {
            try {
                manager.unregisterNetworkCallback(callback)
            } catch (_: IllegalArgumentException) {
                // Callback was not registered or has already been removed.
            }
        }
    }

    private fun rejectPendingConnect(code: String, message: String, cause: Throwable? = null) {
        val promise: Promise?
        synchronized(lock) {
            promise = pendingConnectPromise
            pendingConnectPromise = null
        }
        promise?.reject(code, message, cause)
    }
}
