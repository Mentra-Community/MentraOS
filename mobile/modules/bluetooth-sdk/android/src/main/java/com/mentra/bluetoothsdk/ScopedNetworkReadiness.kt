package com.mentra.bluetoothsdk

internal class ScopedNetworkReadiness<T> {
    private var candidate: T? = null

    fun onAvailable(network: T) {
        candidate = network
    }

    fun isReady(network: T, isForeground: Boolean): Boolean = candidate == network && isForeground

    fun contains(network: T): Boolean = candidate == network

    fun clear() {
        candidate = null
    }
}
