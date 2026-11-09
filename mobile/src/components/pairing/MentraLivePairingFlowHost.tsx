import CrustModule from "@mentra/crust"
import {DeviceTypes, engine, SETTINGS, useSetting} from "@mentra/engine"
import {
  MentraLivePairingPages,
  useMentraLivePairing,
  type MentraLivePairingEntryPage,
  type MentraLivePairingPage,
} from "@mentra/engine/pairing"
import {useVideoPlayer, VideoView} from "expo-video"
import {useCallback, useState} from "react"
import {PermissionsAndroid, Platform} from "react-native"

import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import {CDN_BASE_URL} from "@/constants/appConfig"
import {focusEffectPreventBack, usePushPrevious, usePushUnder} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n/translate"
import {deploymentStore} from "@/services/deployment"
import {isGlassesModelAllowedByDeployment} from "@/services/deployment/glassesPolicy"
import {deploymentSignInRoute} from "@/services/deployment/signInRoute"
import {useNavigationStore} from "@/stores/navigation"
import showAlert from "@/utils/AlertUtils"
import {logPermissionAlert} from "@/utils/permissionLog"
import {getGlassesOpenImage} from "@/utils/getGlassesImage"
import {type ForgetIosPairingThen} from "@/utils/pairing/iosStaleBond"
import {preparePairingScan} from "@/utils/pairing/preparePairingScan"
import {unpairSavedGlasses} from "@/utils/pairing/unpairSavedGlasses"
import {PermissionFeatures, requestFeaturePermissions} from "@/utils/PermissionsUtils"
import {SettingsNavigationUtils} from "@/utils/SettingsNavigationUtils"

const IMAGES = {
  glasses: getGlassesOpenImage(DeviceTypes.LIVE),
  prep: require("@assets/onboarding/live/thumbnails/ONB0_power.png"),
  success: require("@assets/onboarding/live/thumbnails/ONB0_power.png"),
  pairAudio: require("@assets/onboarding/os/thumbnails/btclassic.png"),
  forgetIosPairing: require("@assets/onboarding/live/forget-ios-pairing.png"),
}

/** The Engine's Mentra Live pairing flow inside the Mentra App's navigation, theme and copy. */
export function MentraLivePairingFlowHost({
  initialPage,
  deviceName,
  then,
}: {
  initialPage: MentraLivePairingEntryPage
  deviceName?: string
  /** After a standalone "Forget the old pairing": where to go. */
  then?: ForgetIosPairingThen
}) {
  const {theme} = useAppTheme()
  const pushUnder = usePushUnder()
  const pushPrevious = usePushPrevious()
  const [showHelp, setShowHelp] = useState(false)
  const [superMode] = useSetting<boolean>(SETTINGS.super_mode.key)

  const handleExit = useCallback(
    (from: MentraLivePairingPage) => {
      const {goBack, clearHistoryAndGoHome, replaceAll} = useNavigationStore.getState()
      if (from === "forget_ios_pairing") {
        if (then === "sign-in") return replaceAll(deploymentSignInRoute(deploymentStore.getActive()))
        return clearHistoryAndGoHome()
      }
      if (from === "failure" || (from === "pair_audio" && initialPage !== "pair_audio")) return clearHistoryAndGoHome()
      goBack()
    },
    [initialPage, then],
  )

  const handleFinished = useCallback(async () => {
    const {clearHistoryAndGoHome, push} = useNavigationStore.getState()
    if (initialPage === "pair_audio") {
      pushPrevious()
      return
    }
    // Android pairs Bluetooth Classic at the native stack level, so Pair Audio is never needed there.
    // The OTA check runs on the phone; Wi-Fi is only needed once an update is confirmed.
    const classicConnected =
      Platform.OS === "android" || (await engine.pairing.waitForBluetoothClassic({timeoutMs: 1000}))
    const routes = [...(classicConnected ? [] : ["/pairing/btclassic"]), "/ota/check-for-updates"]
    clearHistoryAndGoHome()
    push(routes[0])
    for (const route of routes.slice(1).reverse()) pushUnder(route)
  }, [initialPage, pushPrevious, pushUnder])

  const controller = useMentraLivePairing({
    initialPage,
    deviceName,
    initializeRuntime: false,
    onExit: handleExit,
    onFinished: () => void handleFinished(),
    onRetry: () => {
      const {clearHistoryAndGoHome, push} = useNavigationStore.getState()
      clearHistoryAndGoHome()
      push("/pairing/select-glasses-model")
    },
    prepareScan: async () => {
      if (!isGlassesModelAllowedByDeployment(DeviceTypes.LIVE)) {
        useNavigationStore.getState().goBack()
        return false
      }
      return preparePairingScan(DeviceTypes.LIVE)
    },
    prepareConnect: async () => {
      if (Platform.OS !== "android" || (await requestFeaturePermissions(PermissionFeatures.LOCATION))) return true
      const fineLocation = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION)
      logPermissionAlert("location", `ACCESS_FINE_LOCATION check=${fineLocation}`, "pairing_location_permission")
      showAlert(
        "Location Permission Required",
        "Location permission is required to scan for and connect to smart glasses on Android. This is a requirement of the Android Bluetooth system.",
        [{text: "OK"}],
      )
      return false
    },
    openBluetoothSettings: () => SettingsNavigationUtils.openBluetoothSettings(),
    unpair: unpairSavedGlasses,
  })

  // Android Back is the page's back action. On iOS the swipe is off while back is prevented, and the
  // flow's own exits navigate, so a removal event is never a back request here.
  const {back} = controller
  focusEffectPreventBack(
    useCallback(
      (event?: unknown) => {
        if (!event) back()
      },
      [back],
    ),
  )

  const useRemoteMedia = deploymentStore.getActive().kind === "consumer"

  return (
    <>
      <MentraLivePairingPages
        controller={controller}
        images={IMAGES}
        onOpenHelp={() => setShowHelp(true)}
        onShowAudioDevicePicker={() => CrustModule.showAVRoutePicker(theme.colors.text)}
        prepMedia={useRemoteMedia ? <PowerButtonVideo /> : undefined}
        setupRemaining
        showAlert={showAlert}
        superMode={Boolean(superMode)}
        theme={{
          background: theme.colors.background,
          card: theme.colors.primary_foreground,
          foreground: theme.colors.foreground,
          buttonBackground: theme.colors.secondary_foreground,
          textDim: theme.colors.textDim,
          mutedForeground: theme.colors.muted_foreground,
          primary: theme.colors.primary,
          border: theme.colors.border,
          error: theme.colors.chart_5,
          errorBackground: theme.colors.errorBackground || theme.colors.palette.angry100,
        }}
        translate={(key, options) => translate(key as never, options)}
      />
      <GlassesTroubleshootingModal
        deviceModel={DeviceTypes.LIVE}
        isVisible={showHelp}
        onClose={() => setShowHelp(false)}
      />
    </>
  )
}

const VIDEO_STYLE = {height: "100%", width: "100%"} as const

function PowerButtonVideo() {
  const player = useVideoPlayer(`${CDN_BASE_URL}/onboarding/mentra-live/light/ONB1_power_button_loop.mp4`, (p) => {
    p.loop = true
    p.muted = true
    p.play()
  })
  // The video never takes touches: on Android, VideoView re-sends them to JS.
  return (
    <VideoView contentFit="contain" nativeControls={false} player={player} pointerEvents="none" style={VIDEO_STYLE} />
  )
}
