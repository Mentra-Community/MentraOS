package com.mentra.core.utils

object DeviceTypes {
    const val SIMULATED = "Simulated Glasses"
    const val G1 = "Even Realities G1"
    const val NEX = "Mentra Nex"
    const val MACH1 = "Mentra Mach1"
    const val LIVE = "Mentra Live"
    const val Z100 = "Vuzix Z100"
    const val FRAME = "Brilliant Frame"
    val ALL = arrayOf(SIMULATED, G1, MACH1, LIVE, Z100, FRAME, NEX)
}

object ConnTypes {
    const val CONNECTING = "CONNECTING"
    const val CONNECTED = "CONNECTED"
    const val DISCONNECTED = "DISCONNECTED"
    const val SCANNING = "SCANNING"
    const val BONDING = "BONDING"
}

object MicTypes {
    const val PHONE_INTERNAL = "phone"
    const val GLASSES_CUSTOM = "glasses"
    const val BT_CLASSIC = "btclassic"
    const val BT = "bt"
    val ALL = arrayOf(PHONE_INTERNAL, GLASSES_CUSTOM, BT_CLASSIC, BT)
}

// convert to kotlin:
object MicMap {
    val map: Map<String, List<String>> = mapOf(
        "auto" to listOf(MicTypes.GLASSES_CUSTOM, MicTypes.PHONE_INTERNAL, MicTypes.BT, MicTypes.BT_CLASSIC),
        "glasses" to listOf(MicTypes.GLASSES_CUSTOM),
        "phone" to listOf(MicTypes.PHONE_INTERNAL, MicTypes.GLASSES_CUSTOM),
        "bluetooth" to listOf(MicTypes.BT, MicTypes.BT_CLASSIC, MicTypes.PHONE_INTERNAL, MicTypes.GLASSES_CUSTOM),
    )
}