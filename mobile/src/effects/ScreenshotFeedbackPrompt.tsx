import {useEffect} from "react"
import {Platform} from "react-native"
import CrustModule from "crust"
import * as ScreenCapture from "expo-screen-capture"

import {useNavigationStore} from "@/stores/navigation"
import {showAlert} from "@/contexts/ModalContext"
import {translate} from "@/i18n"

export function ScreenshotFeedbackPrompt() {
  const {push} = useNavigationStore.getState()
  useEffect(() => {
    if (Platform.OS !== "ios") return

    let subscription: ReturnType<typeof ScreenCapture.addScreenshotListener> | null = null

    CrustModule.isBetaBuild().then((isBeta) => {
      if (!isBeta) return

      subscription = ScreenCapture.addScreenshotListener(async () => {
        const result = await showAlert({
          title: translate("warning:screenshotFeedbackTitle"),
          message: translate("warning:screenshotFeedbackMessage"),
          buttons: [
            {text: translate("common:ignore"), style: "cancel"},
            {text: translate("feedback:giveFeedback"), style: "default"},
          ],
        })

        if (result === 1) {
          push("/miniapps/settings/feedback")
        }
      })
    })

    return () => {
      subscription?.remove()
    }
  }, [])

  return null
}
