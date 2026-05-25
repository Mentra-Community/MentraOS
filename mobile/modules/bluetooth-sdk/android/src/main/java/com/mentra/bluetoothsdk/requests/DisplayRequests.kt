package com.mentra.bluetoothsdk

data class DisplayTextRequest(
    val text: String,
    val x: Int = 0,
    val y: Int = 0,
    val size: Int = 24,
) {
    fun toMap(): Map<String, Any> =
        mapOf(
            "text" to text,
            "x" to x,
            "y" to y,
            "size" to size,
        )
}

internal data class DisplayEventRequest(
    val values: Map<String, Any>,
) {
    fun toMap(): Map<String, Any> = values
}

data class DashboardPositionRequest(
    val height: Int,
    val depth: Int,
)

internal data class DashboardMenuItem(
    val title: String,
    val packageName: String,
    val values: Map<String, Any> = emptyMap(),
) {
    fun toMap(): Map<String, Any> =
        values + mapOf(
            "title" to title,
            "packageName" to packageName,
        )
}
