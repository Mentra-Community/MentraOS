package com.mentra.bluetoothsdk

/** Defaults for the public Bluetooth SDK surface. */
object BluetoothSdkDefaults {
    const val VOICE_ACTIVITY_DETECTION_ENABLED = false
    const val LOUDNESS_GATE_ENABLED = true

    /**
     * Must match the Mentra App default (on). Re-pushed on connect, so this
     * turns on wear detection and the 20-minute unworn power-off on every pair
     * the app touches, except one marked persist.mentra.wear_detection_off=1.
     */
    const val AUTO_POWER_OFF_ENABLED = true
}
