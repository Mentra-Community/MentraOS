import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
// import {useVideoPlayer, VideoView} from "expo-video"
import {View} from "react-native"

// const LOADING_ANIMATION = require("@assets/splash/loading_animation.mp4")

export function SplashVideo({colorOverride}: {colorOverride?: string}) {
  // const player = useVideoPlayer(LOADING_ANIMATION, (player) => {
  //   player.loop = false
  //   player.play()
  // })

  return (
    <View className="flex-1 justify-center items-center bg-background">
      <MentraLogoStandalone width={100} height={53} colorOverride={colorOverride} />
      {/* <VideoView player={player} style={{width: "50%", height: "50%"}} contentFit="contain" nativeControls={false} /> */}
    </View>
  )
}
