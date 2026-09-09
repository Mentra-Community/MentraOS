package com.mentra.bluetoothsdk.sgcs

/** Stable bounded phone-to-firmware ids. Numeric phone ids also need mapping to avoid collisions. */
internal class NotificationIds {
    private val ids = object : LinkedHashMap<String, Int>(32, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Int>) = size > 512
    }
    private var next = 2000
    fun forPhoneId(phoneId: String): Int {
        if (phoneId.isNotEmpty()) ids[phoneId]?.let { return it }
        do { next = if (next >= 9999) 2000 else next + 1 } while (ids.containsValue(next))
        if (phoneId.isNotEmpty()) ids[phoneId] = next
        return next
    }
}
