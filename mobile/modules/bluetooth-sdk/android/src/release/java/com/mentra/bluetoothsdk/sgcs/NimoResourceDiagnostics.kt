package com.mentra.bluetoothsdk.sgcs

import android.content.Context

/** Release builds register no receiver and expose no lifecycle control surface. */
@Suppress("UNUSED_PARAMETER")
internal object NimoResourceDiagnostics {
    fun start(context: Context) {}
    fun track(instance: Nimo) {}
}
