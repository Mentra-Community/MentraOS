import {Platform, View} from "react-native"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"

// TODO: Replace with animated SVG from designer
// Videos for light and dark themes (keeping for future use)
// const LIGHT_VIDEO = require("@assets/splash/loading_animation_light.mp4")
// const DARK_VIDEO = require("@assets/splash/loading_animation_dark.mp4")

// interface SplashVideoProps {
//   onFinished?: () => void
//   loop?: boolean
// }

export function SplashVideo() {
  // stretch vertically slightly to compensate for native splash screen scaling on ios:
  // TBD if this is needed for android as well
  // if (Platform.OS === "ios") {
  //   return (
  //     <View
  //       style={{transform: [{scaleY: 1.12}, {scaleX: 1}]}}
  //       className="flex-1 justify-center items-center bg-background">
  //       <MentraLogoStandalone width={100} height={53} />
  //     </View>
  //   )
  // }
  return (
    <View className="flex-1 justify-center items-center bg-background">
      <MentraLogoStandalone width={100} height={53} />
    </View>
  )
}
