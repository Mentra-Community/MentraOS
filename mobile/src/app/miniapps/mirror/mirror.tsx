import {useRef} from "react"
import {View} from "react-native"

import {Screen} from "@/components/ignite"
import {Group} from "@/components/ui"
import GlassesDisplayMirror from "@/components/mirror/GlassesDisplayMirror"
import {useRegisterCapsule} from "@/stores/capsule"

export default function GallerySettingsScreen() {
  const viewShotRef = useRef<View>(null)
  useRegisterCapsule({
    packageName: "com.mentra.mirror",
    viewShotRef,
    visibleOnRoutes: ["/miniapps/mirror/mirror"],
  })
  return (
    <>
      <Screen preset="fixed" safeAreaEdges={["top"]} ref={viewShotRef}>
        <View className="h-24" />
        <Group>
          <GlassesDisplayMirror fallbackMessage="Glasses mirror" />
        </Group>
      </Screen>
    </>
  )
}
