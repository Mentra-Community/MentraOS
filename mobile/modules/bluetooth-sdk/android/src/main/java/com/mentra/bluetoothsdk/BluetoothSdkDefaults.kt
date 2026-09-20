package com.mentra.bluetoothsdk

/** Defaults for the public Bluetooth SDK surface. */
object BluetoothSdkDefaults {
    const val VOICE_ACTIVITY_DETECTION_ENABLED = false
    const val LOUDNESS_GATE_ENABLED = false

    /**
     * Must stay true. The firmware defaults auto power-off on, and we re-push
     * every Bluetooth setting on connect, so a false default here would
     * silently disable it on every pair the app touches.
     */
    const val AUTO_POWER_OFF_ENABLED = true
}
