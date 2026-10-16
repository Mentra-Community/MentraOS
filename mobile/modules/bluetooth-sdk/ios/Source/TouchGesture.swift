import Foundation

/// Mentra Live touchpad gestures, using the public touch_event names.
public enum TouchGesture: String, CaseIterable, Sendable {
    case singleTap = "single_tap"
    case doubleTap = "double_tap"
    case tripleTap = "triple_tap"
    case longPress = "long_press"
    case forwardSwipe = "forward_swipe"
    case backwardSwipe = "backward_swipe"
    case upSwipe = "up_swipe"
    case downSwipe = "down_swipe"
}
