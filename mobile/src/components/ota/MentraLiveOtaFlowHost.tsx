import {engine, SETTINGS, useSetting} from "@mentra/engine"
import {MentraLiveOtaFlow, type MentraLiveOtaFlowPage} from "@mentra/engine/ota"
import {useCallback, useEffect, useState} from "react"

import {useConnectionOverlayConfig} from "@/contexts/ConnectionOverlayContext"
import {focusEffectLockScreen} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {useKeepAwakeWhile} from "@/hooks/useKeepAwakeWhile"
import {translate} from "@/i18n/translate"
import {useNavigationStore} from "@/stores/navigation"
import {getNextOnboardingRoute} from "@/utils/onboarding/getNextOnboardingRoute"

const OTA_KEEP_AWAKE_TAG = "mentra-live-ota"

export function MentraLiveOtaFlowHost({initialPage = "check"}: {initialPage?: MentraLiveOtaFlowPage}) {
  const {theme} = useAppTheme()
  const {clearHistoryAndGoHome, push, replace} = useNavigationStore.getState()
  const {clearConfig, setConfig} = useConnectionOverlayConfig()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [onboardingLiveCompleted] = useSetting(SETTINGS.onboarding_live_completed.key)
  const [onboardingOsCompleted] = useSetting(SETTINGS.onboarding_os_completed.key)
  const [superMode] = useSetting(SETTINGS.super_mode.key)

  // Every page of this flow — download, install, "Restarting Mentra Live" —
  // is one-way and renders no back affordance. Leaving mid-update strands the
  // glasses half-installed with no route back to the progress UI, so lock the
  // screen instead of merely asking the navigator not to go back.
  focusEffectLockScreen()
  useEffect(() => clearConfig, [clearConfig])

  // Keep the phone awake from the moment the progress page mounts until the
  // install reaches a terminal state, so the screen never dims or locks while
  // the glasses are downloading, installing, or restarting into the update.
  const [progressActive, setProgressActive] = useState(initialPage === "progress")
  const installDisplayState = useEngineSnapshot(engine.ota.installSession.snapshot, (onChange) =>
    engine.ota.installSession.onSnapshot(onChange),
  ).displayState
  const installSettled = installDisplayState === "complete" || installDisplayState === "failed"
  useKeepAwakeWhile(progressActive && !installSettled, OTA_KEEP_AWAKE_TAG)

  const handleFinished = useCallback(() => {
    const nextRoute = getNextOnboardingRoute({includeMentraLive: true, onboardingLiveCompleted, onboardingOsCompleted})
    if (nextRoute) {
      replace(nextRoute)
      return
    }
    clearHistoryAndGoHome()
  }, [clearHistoryAndGoHome, onboardingLiveCompleted, onboardingOsCompleted, replace])

  const handleFirmwareRestartingChange = useCallback(
    (restarting: boolean, progressActive: boolean) => {
      setProgressActive(progressActive)
      if (!progressActive) {
        clearConfig()
      } else if (restarting) {
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
    [clearConfig, setConfig],
  )

  const handleOpenWifiSetup = useCallback(() => {
    clearConfig()
    push("/wifi/scan")
  }, [clearConfig, push])

  return (
    <MentraLiveOtaFlow
      allowDevSkip={__DEV__}
      deviceName={defaultWearable || "Glasses"}
      initialPage={initialPage}
      initializeRuntime={false}
      onFinished={handleFinished}
      onFirmwareRestartingChange={handleFirmwareRestartingChange}
      onOpenWifiSetup={handleOpenWifiSetup}
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
