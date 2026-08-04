import {makeMutable, type SharedValue} from "react-native-reanimated"

// AppSwitcher open progress: 0 = closed, 1 = open. Module-level (rather than a
// useSharedValue inside the home route) so the Compositor overlay — mounted
// outside the router — can drive the switcher reveal from its bottom swipe-up
// gesture alongside AppSwitcherButton's pan and AppSwitcher's close.
export const appSwitcherProgress: SharedValue<number> = makeMutable(0)

// Shared by AppSwitcherButton's pill swipe and Compositor's bottom swipe-up so
// both gestures commit with the same feel.
export const SWIPE_DISTANCE_THRESHOLD = 300 // Distance needed to trigger open
export const SWIPE_PERCENT_THRESHOLD = 0.2
export const OPEN_SPRING = {damping: 20, stiffness: 2000, overshootClamping: true}
