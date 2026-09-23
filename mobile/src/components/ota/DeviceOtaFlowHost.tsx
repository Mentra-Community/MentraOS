import {engine, SETTINGS, useSetting} from "@mentra/engine"
import {
  FirmwareUpdateFlow,
  type FirmwareEntryPoint,
  type FirmwareSnapshot,
  type MentraLiveOtaFlowPage,
} from "@mentra/engine/ota"
import {useCallback, useEffect, useRef} from "react"

import {useConnectionOverlayConfig} from "@/contexts/ConnectionOverlayContext"
import {focusEffectLockScreen} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n/translate"
import {useNavigationStore} from "@/stores/navigation"
import {getNextOnboardingRoute} from "@/utils/onboarding/getNextOnboardingRoute"

export function DeviceOtaFlowHost({
  initialPage = "check",
  entryPoint = "pairing",
}: {
  initialPage?: MentraLiveOtaFlowPage
  entryPoint?: FirmwareEntryPoint
}) {
  const {theme} = useAppTheme()
  const {clearHistoryAndGoHome, push, replace, goBack} = useNavigationStore.getState()
  const {clearConfig, setConfig} = useConnectionOverlayConfig()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [onboardingLiveCompleted] = useSetting(SETTINGS.onboarding_live_completed.key)
  const [onboardingOsCompleted] = useSetting(SETTINGS.onboarding_os_completed.key)
  const [superMode] = useSetting(SETTINGS.super_mode.key)
  const setup = engine.firmwareUpdates.pairingPolicy(defaultWearable ?? "")
  const snapshotRef = useRef<FirmwareSnapshot | null>(null)

  // Every page of this flow — download, install, "Restarting Mentra Live" —
  // is one-way and renders no back affordance. Leaving mid-update strands the
  // glasses half-installed with no route back to the progress UI, so lock the
  // screen instead of merely asking the navigator not to go back.
  focusEffectLockScreen()
  useEffect(() => clearConfig, [clearConfig])

  const handleFinished = useCallback(() => {
    if (entryPoint !== "pairing" && !setup.onboardingFlowId) {
      goBack()
      return
    }
    const nextRoute = getNextOnboardingRoute({
      includeMentraLive: setup.onboardingFlowId === "mentra-live",
      onboardingLiveCompleted,
      onboardingOsCompleted: onboardingOsCompleted || !setup.includeOsOnboarding,
    })
    if (nextRoute) {
      replace(nextRoute)
      return
    }
    clearHistoryAndGoHome()
  }, [
    clearHistoryAndGoHome,
    goBack,
    entryPoint,
    onboardingLiveCompleted,
    onboardingOsCompleted,
    replace,
    setup.onboardingFlowId,
    setup.includeOsOnboarding,
  ])

  const handleFirmwareRestartingChange = useCallback(
    (restarting: boolean, progressActive: boolean) => {
      if (!progressActive) {
        clearConfig()
      } else if (restarting) {
        setConfig({
          customTitle: translate("ota:deviceRestartingReconnect", {deviceName: defaultWearable || "Glasses"}),
          customMessage: "",
          hideStopButton: true,
          smallTitle: true,
          suppressOverlay: false,
        })
      } else {
        setConfig({suppressOverlay: true})
      }
    },
    [clearConfig, setConfig, defaultWearable],
  )

  const handleOpenWifiSetup = useCallback(() => {
    clearConfig()
    const target = snapshotRef.current?.target
    if (!target) return
    push("/wifi/scan", {
      firmwareReturn: "true",
      firmwareEntryPoint: entryPoint,
      firmwareDeviceId: target.deviceId,
      firmwareIntegrationId: target.integrationId,
    })
  }, [clearConfig, push, entryPoint])

  return (
    <FirmwareUpdateFlow
      allowDevelopmentSkip={__DEV__}
      entryPoint={entryPoint}
      legacyProgressEntry={initialPage === "progress"}
      initializeRuntime={false}
      onSnapshot={(snapshot) => {
        snapshotRef.current = snapshot
      }}
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
