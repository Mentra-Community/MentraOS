import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
// import {useVideoPlayer, VideoView} from "expo-video"
import {View} from "react-native"

import {Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"

// const LOADING_ANIMATION = require("@assets/splash/loading_animation.mp4")

export function SplashVideo({label}: {label?: string}) {
  const {theme} = useAppTheme()
  // const player = useVideoPlayer(LOADING_ANIMATION, (player) => {
  //   player.loop = false
  //   player.play()
  // })

  return (
    <View className="flex-1 justify-center items-center bg-background">
      {/* Keep the logo perfectly centered; the label is absolutely positioned
          below it so showing/hiding the text never shifts the logo. */}
      <MentraLogoStandalone width={100} height={53} />
      {/* <VideoView player={player} style={{width: "50%", height: "50%"}} contentFit="contain" nativeControls={false} /> */}
      {label ? (
        <Text
          text={label}
          className="text-xs text-center absolute"
          style={{top: "55%", color: theme.colors.textDim, paddingHorizontal: theme.spacing.s6}}
        />
      ) : null}
    </View>
  )
}
