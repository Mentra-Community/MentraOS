import {SETTINGS, useSetting} from "@mentra/engine"
import {MentraLiveOtaFlow, type MentraLiveOtaFlowPage} from "@mentra/engine/react"
import {useCallback, useEffect} from "react"

import {useConnectionOverlayConfig} from "@/contexts/ConnectionOverlayContext"
import {focusEffectPreventBack} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n/translate"
import {useNavigationStore} from "@/stores/navigation"
import {getNextOnboardingRoute} from "@/utils/onboarding/getNextOnboardingRoute"

export function MentraLiveOtaFlowHost({initialPage = "check"}: {initialPage?: MentraLiveOtaFlowPage}) {
  const {theme} = useAppTheme()
  const {clearHistoryAndGoHome, push, replace} = useNavigationStore.getState()
  const {clearConfig, setConfig} = useConnectionOverlayConfig()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [onboardingLiveCompleted] = useSetting(SETTINGS.onboarding_live_completed.key)
  const [onboardingOsCompleted] = useSetting(SETTINGS.onboarding_os_completed.key)
  const [superMode] = useSetting(SETTINGS.super_mode.key)

  focusEffectPreventBack()
  useEffect(() => clearConfig, [clearConfig])

  const handleFinished = useCallback(() => {
    const nextRoute = getNextOnboardingRoute({includeMentraLive: true, onboardingLiveCompleted, onboardingOsCompleted})
    if (nextRoute) {
      replace(nextRoute)
      return
    }
    clearHistoryAndGoHome()
  }, [clearHistoryAndGoHome, onboardingLiveCompleted, onboardingOsCompleted, replace])

  const handleFirmwareRestartingChange = useCallback(
    (restarting: boolean) => {
      if (restarting) {
        setConfig({
          customTitle: "Please wait while Mentra Live restarts and automatically reconnects...",
          customMessage: "",
          hideStopButton: true,
          smallTitle: true,
          suppressOverlay: false,
        })
      } else {
        setConfig({suppressOverlay: true})
      }
    },
    [setConfig],
  )

  return (
    <MentraLiveOtaFlow
      allowDevSkip={__DEV__}
      deviceName={defaultWearable || "Glasses"}
      initialPage={initialPage}
      initializeRuntime={false}
      onFinished={handleFinished}
      onFirmwareRestartingChange={handleFirmwareRestartingChange}
      onOpenWifiSetup={() => push("/wifi/scan")}
      superMode={Boolean(superMode)}
      theme={{
        background: theme.colors.background,
        border: theme.colors.border,
        error: theme.colors.error,
        foreground: theme.colors.foreground,
        primary: theme.colors.primary,
        textDim: theme.colors.textDim,
      }}
      translate={(key, options) => translate(key as never, options)}
    />
  )
}
