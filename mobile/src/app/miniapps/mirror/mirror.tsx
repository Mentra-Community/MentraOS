import {useRef} from "react"
import {View} from "react-native"

import {Screen} from "@/components/ignite"
import {MiniAppDualButtonHeader} from "@/components/miniapps/DualButton"
import ConnectedSimulatedGlassesInfo from "@/components/mirror/ConnectedSimulatedGlassesInfo"
import {Group} from "@/components/ui"

export default function GallerySettingsScreen() {
  const viewShotRef = useRef<View>(null)
  return (
    <Screen preset="fixed" safeAreaEdges={["top"]} ref={viewShotRef}>
      <MiniAppDualButtonHeader packageName="com.mentra.mirror" viewShotRef={viewShotRef} />
      <View className="h-24" />

      <Group>
        <ConnectedSimulatedGlassesInfo showHeader={false} />
      </Group>
    </Screen>
  )
}
