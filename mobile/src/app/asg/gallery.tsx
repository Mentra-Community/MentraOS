import {GalleryScreen} from "@/components/glasses/Gallery/GalleryScreen"
import {Screen} from "@/components/ignite"
import {cameraPackageName} from "@/constants/miniapps"
import {useRegisterCapsule} from "@/stores/capsule"
import {useRef} from "react"
import {View} from "react-native"

export default function AsgGallery() {
  const viewShotRef = useRef<View>(null)

  useRegisterCapsule({
    packageName: cameraPackageName,
    viewShotRef,
    visibleOnRoutes: ["/asg/gallery"],
  })
  return (
    <Screen preset="fixed" safeAreaEdges={["top"]} ref={viewShotRef}>
      <GalleryScreen />
    </Screen>
  )
}
