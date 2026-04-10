import {GalleryScreen} from "@/components/glasses/Gallery/GalleryScreen"
import {Screen} from "@/components/ignite"
import {MiniAppCapsuleMenu} from "@/components/miniapps/CapsuleMenu"
import {cameraPackageName} from "@/stores/applets"
import {useRef} from "react"
import {View} from "react-native"

export default function AsgGallery() {
  const viewShotRef = useRef<View>(null)

  return (
    <>
      <MiniAppCapsuleMenu packageName={cameraPackageName} viewShotRef={viewShotRef} />
      <Screen preset="fixed" safeAreaEdges={["top"]} ref={viewShotRef}>
        <GalleryScreen />
      </Screen>
    </>
  )
}
