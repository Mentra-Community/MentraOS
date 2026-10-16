package com.mentra.bluetoothsdk.sgcs

import android.content.Context

/** Release builds register no receiver and expose no lifecycle control surface. */
@Suppress("UNUSED_PARAMETER")
internal object NimoResourceDiagnostics {
    fun start(context: Context) {}
    fun track(instance: Nimo) {}
    fun dispatchCapturedEntry(entry: () -> Unit) = false
    fun allowManagerConnect(wearable: String, name: String? = null) = true
    fun admit(instance: Nimo, name: String?, connect: Boolean) = true
    fun allowPeer(instance: Nimo, address: String, bonded: Boolean) = true
    fun beginTransport(instance: Nimo, address: String, bonded: Boolean) = true
}
