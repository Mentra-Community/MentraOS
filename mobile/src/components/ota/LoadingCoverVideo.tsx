import {useVideoPlayer, VideoView} from "expo-video"
import {useEffect, useState} from "react"
import {View, Modal} from "react-native"
import {useSafeAreaInsets} from "react-native-safe-area-context"

import {Button} from "@/components/ignite"

interface LoadingCoverVideoProps {
  videoUrl: string
  onClose?: () => void
}

export function LoadingCoverVideo({videoUrl, onClose}: LoadingCoverVideoProps) {
  const insets = useSafeAreaInsets()
  const [isReady, setIsReady] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  const player = useVideoPlayer(videoUrl, (player) => {
    player.loop = false
    player.muted = false
  })

  useEffect(() => {
    if (!player) return

    const statusSubscription = player.addListener("statusChange", (event) => {
      console.log("LoadingCoverVideo: status changed:", event)
      if (event.status === "readyToPlay") {
        setIsReady(true)
        player.play()
      } else if (event.status === "error") {
        console.log("LoadingCoverVideo: error loading video")
        setHasError(true)
      }
    })

    const endSubscription = player.addListener("playToEnd", () => {
      console.log("LoadingCoverVideo: video finished playing")
      setDismissed(true)
      onClose?.()
    })

    return () => {
      statusSubscription.remove()
      endSubscription.remove()
    }
  }, [player, onClose])

  const handleClose = () => {
    console.log("LoadingCoverVideo: user dismissed")
    setDismissed(true)
    onClose?.()
  }

  // If error or dismissed, render nothing
  if (hasError || dismissed) {
    return null
  }

  // If not ready yet, render nothing (preloading in background)
  if (!isReady) {
    return null
  }

  // Ready - show fullscreen video overlay
  return (
    <Modal transparent animationType="fade" visible={true}>
      <View style={{flex: 1, backgroundColor: "black"}}>
        <VideoView player={player} style={{flex: 1}} contentFit="contain" nativeControls={false} />
        <View style={{position: "absolute", bottom: insets.bottom + 20, left: 20, right: 20}}>
          <Button text="Close Video" preset="secondary" onPress={handleClose} />
        </View>
      </View>
    </Modal>
  )
}
