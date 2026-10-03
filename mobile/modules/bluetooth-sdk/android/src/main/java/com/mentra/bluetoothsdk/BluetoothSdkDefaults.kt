package com.mentra.bluetoothsdk

/** Defaults for the public Bluetooth SDK surface. */
object BluetoothSdkDefaults {
    const val VOICE_ACTIVITY_DETECTION_ENABLED = false
    const val LOUDNESS_GATE_ENABLED = false

    /** Off until someone turns it on in Super Mode. Re-pushed on connect. */
    const val AUTO_POWER_OFF_ENABLED = false
}
