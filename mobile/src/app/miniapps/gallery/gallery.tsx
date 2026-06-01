import {GalleryScreen} from "@/components/glasses/Gallery/GalleryScreen"
import {Screen} from "@/components/ignite"
import {useNavigationStore} from "@/stores/navigation"
import {useRef} from "react"
import {captureRef} from "react-native-view-shot"

export default function AsgGallery() {
  const viewShotRef = useRef(null)
  const {goBack} = useNavigationStore.getState()

  const handleExit = async () => {
    // take a screenshot of the webview and save it to the applet zustand store:
    try {
      const uri = await captureRef(viewShotRef, {
        format: "jpg",
        quality: 0.5,
      })
    } catch (e) {
      console.warn("screenshot failed:", e)
    }
    // goBack()
  }

  return (
    <Screen preset="fixed" ref={viewShotRef}>
      <GalleryScreen />
    </Screen>
  )
}
