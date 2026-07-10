package com.mentra.examples.android

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.CancellationException
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resumeWithException

class GlassesHotspotConnector(context: Context) {
    private val connectivityManager =
        context.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private var callback: ConnectivityManager.NetworkCallback? = null
    private var pendingContinuation: CancellableContinuation<Unit>? = null

    suspend fun connect(ssid: String, password: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            throw IOException("Automatic hotspot connection requires Android 10 or newer.")
        }
        disconnect()
        withTimeout(35_000) {
            suspendCancellableCoroutine { continuation ->
                pendingContinuation = continuation
                val completed = AtomicBoolean(false)
                val specifier = WifiNetworkSpecifier.Builder()
                    .setSsid(ssid)
                    .setWpa2Passphrase(password)
                    .build()
                val request = NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .setNetworkSpecifier(specifier)
                    .build()
                val networkCallback = object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        if (!connectivityManager.bindProcessToNetwork(network)) {
                            if (completed.compareAndSet(false, true)) {
                                pendingContinuation = null
                                continuation.resumeWithException(IOException("Could not route gallery traffic over the glasses hotspot."))
                            }
                            return
                        }
                        if (completed.compareAndSet(false, true)) {
                            pendingContinuation = null
                            continuation.resumeWith(Result.success(Unit))
                        }
                    }

                    override fun onUnavailable() {
                        if (completed.compareAndSet(false, true)) {
                            pendingContinuation = null
                            continuation.resumeWithException(IOException("The glasses hotspot connection was not approved or could not be found."))
                        }
                    }

                    override fun onLost(network: Network) {
                        connectivityManager.bindProcessToNetwork(null)
                    }
                }
                callback = networkCallback
                continuation.invokeOnCancellation { releaseNetwork() }
                connectivityManager.requestNetwork(request, networkCallback)
            }
        }
    }

    fun disconnect() {
        val continuation = pendingContinuation
        pendingContinuation = null
        releaseNetwork()
        continuation?.cancel(CancellationException("Glasses hotspot connection cancelled."))
    }

    private fun releaseNetwork() {
        connectivityManager.bindProcessToNetwork(null)
        callback?.let { current ->
            runCatching { connectivityManager.unregisterNetworkCallback(current) }
        }
        callback = null
    }
}
