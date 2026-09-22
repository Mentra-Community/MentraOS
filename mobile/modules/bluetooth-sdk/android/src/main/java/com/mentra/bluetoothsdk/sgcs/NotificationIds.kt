package com.mentra.bluetoothsdk.sgcs

/**
 * IDs remain stable for this driver's lifetime, including reconnects. Firmware history removal
 * is not observable, so never recycle an ID that may still identify a retained card.
 */
internal class NotificationIds {
    private val ids = mutableMapOf<String, Int>()
    private var next = 2000

    fun forPhoneId(phoneId: String): Int {
        if (phoneId.isNotEmpty()) ids[phoneId]?.let { return it }
        check(next <= 9999) { "notification_id_capacity_exhausted" }
        val id = next++
        // Anonymous notifications also consume an ID; reusing one could replace an unrelated card.
        if (phoneId.isNotEmpty()) ids[phoneId] = id
        return id
    }
}
