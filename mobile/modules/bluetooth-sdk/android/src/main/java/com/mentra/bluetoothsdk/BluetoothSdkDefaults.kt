package com.mentra.bluetoothsdk

/** Defaults for the public Bluetooth SDK surface. */
object BluetoothSdkDefaults {
    const val VOICE_ACTIVITY_DETECTION_ENABLED = false
    const val LOUDNESS_GATE_ENABLED = true

    /**
     * Must match the firmware and Mentra App default (off). Re-pushed on
     * connect, so a true value here turns on the 20-minute unworn power-off on
     * every pair the app touches.
     */
    const val AUTO_POWER_OFF_ENABLED = false
}
