package com.mentra.bluetoothsdk

/** Mentra Live touchpad gestures, using the public touch_event names. */
enum class TouchGesture(val wireName: String) {
    SINGLE_TAP("single_tap"),
    DOUBLE_TAP("double_tap"),
    TRIPLE_TAP("triple_tap"),
    LONG_PRESS("long_press"),
    FORWARD_SWIPE("forward_swipe"),
    BACKWARD_SWIPE("backward_swipe"),
    UP_SWIPE("up_swipe"),
    DOWN_SWIPE("down_swipe");

    companion object {
        fun fromWireName(value: String): TouchGesture =
            entries.firstOrNull { it.wireName == value }
                ?: throw BluetoothSdkException("invalid_touch_gesture", "Unknown touch gesture: $value")
    }
}
