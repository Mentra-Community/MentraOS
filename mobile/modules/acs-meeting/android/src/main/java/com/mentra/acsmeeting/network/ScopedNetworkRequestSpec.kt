package com.mentra.acsmeeting.network

import android.net.NetworkCapabilities

/**
 * Declarative description of the SoftAP network request.
 *
 * `NetworkRequest.Builder` cannot be constructed in a plain JVM test, so the shape of the request
 * lives here as data and [ScopedSoftApNetwork] translates it into the real builder. That makes the
 * one property this architecture depends on — that the request does **not** ask for
 * `NET_CAPABILITY_INTERNET` — assertable without a device.
 *
 * Dropping the internet capability is what keeps the phone dual-homed: Android will not promote the
 * glasses hotspot to the default network, so ACS traffic stays on cellular while media crosses the
 * local link. The other half of that guarantee is the MTK firmware patch that stops the AP
 * advertising a default route.
 */
data class ScopedNetworkRequestSpec(
    val ssid: String,
    val passphrase: String,
    val transportTypes: Set<Int>,
    val removedCapabilities: Set<Int>,
    val timeoutMs: Int,
) {
    /** True when the request cannot be satisfied by, or promoted to, an internet-bearing network. */
    val avoidsInternetCapability: Boolean
        get() = removedCapabilities.contains(NetworkCapabilities.NET_CAPABILITY_INTERNET)

    val hasPassphrase: Boolean
        get() = passphrase.isNotEmpty()

    companion object {
        /**
         * Android caps `requestNetwork` timeouts well above this; 30 s matches the value the
         * Bluetooth SDK already uses for the same hotspot and is long enough for a cold AP start.
         */
        const val DEFAULT_TIMEOUT_MS = 30_000

        /** The canonical SoftAP request. Every caller should go through this. */
        fun forSoftAp(
            ssid: String,
            passphrase: String,
            timeoutMs: Int = DEFAULT_TIMEOUT_MS,
        ): ScopedNetworkRequestSpec =
            ScopedNetworkRequestSpec(
                ssid = ssid,
                passphrase = passphrase,
                transportTypes = setOf(NetworkCapabilities.TRANSPORT_WIFI),
                removedCapabilities = setOf(NetworkCapabilities.NET_CAPABILITY_INTERNET),
                timeoutMs = timeoutMs,
            )
    }
}
