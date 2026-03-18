import {Platform} from "react-native"
import * as Haptics from "expo-haptics"

export const hapticBuzz = () => {
  if (Platform.OS === "ios") {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
  } else {
    Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Keyboard_Tap)
  }
}
