import {useLocalSearchParams} from "expo-router"
import {useEffect, useRef} from "react"

import {Screen} from "@/components/ignite"
import {SplashVideo} from "@/components/splash/SplashVideo"
import {useDeeplink} from "@/contexts/DeeplinkContext"
import {translate} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"
import showAlert from "@/utils/AlertUtils"
import {mapAuthError} from "@/utils/auth/authErrors"
import {openAuthBrowser} from "@/utils/auth/openAuthBrowser"

export default function WebSplash() {
  const {goBack} = useNavigationStore.getState()
  const {url} = useLocalSearchParams<{url: string}>()
  const {processUrl} = useDeeplink()
  const processUrlRef = useRef(processUrl)
  processUrlRef.current = processUrl

  useEffect(() => {
    let mounted = true
    const openBrowser = async () => {
      try {
        const completed = url && (await openAuthBrowser(url, (callbackUrl) => processUrlRef.current(callbackUrl)))
        if (!completed && mounted) goBack()
      } catch (error) {
        if (mounted) {
          goBack()
          showAlert(translate("common:error"), mapAuthError(error instanceof Error ? error : String(error)))
        }
      }
    }
    void openBrowser()
    return () => {
      mounted = false
    }
  }, [url, goBack])

  return (
    <Screen preset="fixed">
      <SplashVideo />
    </Screen>
  )
}
