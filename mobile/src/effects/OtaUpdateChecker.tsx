import {Capabilities, getModelCapabilities} from "@/../../cloud/packages/types/src"
import {useEffect, useRef} from "react"

import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import showAlert from "@/utils/AlertUtils"
import {translate} from "@/i18n/translate"
import {usePathname} from "expo-router"

export interface VersionInfo {
  versionCode: number
  versionName: string
  downloadUrl: string
  apkSize: number
  sha256: string
  releaseNotes: string
}

interface VersionJson {
  apps?: {
    [packageName: string]: VersionInfo
  }
  // Legacy format support
  versionCode?: number
  versionName?: string
  downloadUrl?: string
  apkSize?: number
  sha256?: string
  releaseNotes?: string
}

export async function fetchVersionInfo(url: string): Promise<VersionJson | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) {
      console.error("Failed to fetch version info:", response.status)
      return null
    }
    return await response.json()
  } catch (error) {
    console.error("Error fetching version info:", error)
    return null
  }
}

export function checkVersionUpdateAvailable(
  currentBuildNumber: string | undefined,
  versionJson: VersionJson | null,
): boolean {
  if (!currentBuildNumber || !versionJson) {
    return false
  }

  const currentVersion = parseInt(currentBuildNumber, 10)
  if (isNaN(currentVersion)) {
    return false
  }

  let serverVersion: number | undefined

  // Check new format first
  if (versionJson.apps?.["com.mentra.asg_client"]) {
    serverVersion = versionJson.apps["com.mentra.asg_client"].versionCode
  } else if (versionJson.versionCode) {
    // Legacy format
    serverVersion = versionJson.versionCode
  }

  if (!serverVersion || isNaN(serverVersion)) {
    return false
  }

  return serverVersion > currentVersion
}

export function getLatestVersionInfo(versionJson: VersionJson | null): VersionInfo | null {
  if (!versionJson) {
    return null
  }

  // Check new format first
  if (versionJson.apps?.["com.mentra.asg_client"]) {
    return versionJson.apps["com.mentra.asg_client"]
  }

  // Legacy format
  if (versionJson.versionCode) {
    return {
      versionCode: versionJson.versionCode,
      versionName: versionJson.versionName || "",
      downloadUrl: versionJson.downloadUrl || "",
      apkSize: versionJson.apkSize || 0,
      sha256: versionJson.sha256 || "",
      releaseNotes: versionJson.releaseNotes || "",
    }
  }

  return null
}

interface OtaUpdateAvailable {
  hasCheckCompleted: boolean
  updateAvailable: boolean
  latestVersionInfo: VersionInfo | null
}

export async function checkForOtaUpdate(
  otaVersionUrl: string,
  currentBuildNumber: string,
): Promise<OtaUpdateAvailable> {
  try {
    const versionJson = await fetchVersionInfo(otaVersionUrl)
    const latestVersionInfo = getLatestVersionInfo(versionJson)
    const updateAvailable = checkVersionUpdateAvailable(currentBuildNumber, versionJson)
    return {
      hasCheckCompleted: true,
      updateAvailable: updateAvailable,
      latestVersionInfo: latestVersionInfo,
    }
  } catch (error) {
    console.error("Error checking for OTA update:", error)
    return {
      hasCheckCompleted: false,
      updateAvailable: false,
      latestVersionInfo: null,
    }
  }
}

// export function OtaUpdateChecker() {
//   const [isChecking, setIsChecking] = useState(false)
//   const [hasChecked, setHasChecked] = useState(false)
//   const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
//   const {push} = useNavigationHistory()
//   // Extract only the specific values we need to watch to avoid re-renders
//   const glassesModel = useGlassesStore(state => state.modelName)
//   const otaVersionUrl = useGlassesStore(state => state.otaVersionUrl)
//   const currentBuildNumber = useGlassesStore(state => state.buildNumber)
//   const glassesWifiConnected = useGlassesStore(state => state.wifiConnected)

//   useEffect(() => {
//     // Only check for glasses that support WiFi self OTA updates
//     if (!glassesModel) {
//       return
//     }
//     const features: Capabilities = getModelCapabilities(defaultWearable)
//     if (!features || !features.hasWifi) {
//       return
//     }
//     if (!otaVersionUrl || !currentBuildNumber) {
//       return
//     }
//     const asyncCheckForOtaUpdate = async () => {
//       setIsChecking(true)
//       let {hasCheckCompleted, updateAvailable, latestVersionInfo} = await checkForOtaUpdate(
//         otaVersionUrl,
//         currentBuildNumber,
//       )
//       if (hasCheckCompleted) {
//         setHasChecked(true)
//       }
//       if (updateAvailable) {
//         showAlert(
//           "Update Available",
//           `An update for your glasses is available (v${
//             latestVersionInfo?.versionCode || "Unknown"
//           }).\n\nConnect your glasses to WiFi to automatically install the update.`,
//           [
//             {
//               text: "Later",
//               style: "cancel",
//             },
//             {
//               text: "Setup WiFi",
//               onPress: () => {
//                 push("/wifi/scan")
//               },
//             },
//           ],
//         )
//       }
//       setHasChecked(true)
//     }
//     asyncCheckForOtaUpdate()
//   }, [glassesModel, otaVersionUrl, currentBuildNumber, glassesWifiConnected, hasChecked, isChecking])
//   return null
// }

export function OtaUpdateChecker() {
  const [dismissedVersion, setDismissedVersion] = useSetting<string>(SETTINGS.dismissed_ota_version.key)
  const {push} = useNavigationHistory()
  const pathname = usePathname()

  // OTA check state from glasses store
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const glassesConnected = useGlassesStore((state) => state.connected)
  const otaVersionUrl = useGlassesStore((state) => state.otaVersionUrl)
  const buildNumber = useGlassesStore((state) => state.buildNumber)
  const glassesWifiConnected = useGlassesStore((state) => state.wifiConnected)

  // Track if we've already checked this session to avoid repeated prompts
  const hasCheckedOta = useRef(false)

  useEffect(() => {
    // only check if we're on the home screen:
    if (pathname !== "/(tabs)/home" && pathname !== "/home") return

    // OTA check (only for WiFi-capable glasses)
    if (hasCheckedOta.current) return
    if (!glassesConnected || !otaVersionUrl || !buildNumber) return

    const features: Capabilities = getModelCapabilities(defaultWearable)
    if (!features?.hasWifi) return

    checkForOtaUpdate(otaVersionUrl, buildNumber).then(({updateAvailable, latestVersionInfo}) => {
      if (!updateAvailable || !latestVersionInfo) return

      // Skip if user already dismissed this version
      if (dismissedVersion === latestVersionInfo.versionCode?.toString()) return

      hasCheckedOta.current = true

      const deviceName = defaultWearable || "Glasses"

      if (glassesWifiConnected) {
        // WiFi connected - go straight to OTA check screen
        showAlert(
          translate("ota:updateAvailable", {deviceName}),
          translate("ota:updateReadyToInstall", {version: latestVersionInfo.versionCode, deviceName}),
          [
            {
              text: translate("ota:updateLater"),
              style: "cancel",
              onPress: () => setDismissedVersion(latestVersionInfo.versionCode?.toString() ?? ""),
            },
            {text: translate("ota:install"), onPress: () => push("/ota/check-for-updates")},
          ],
        )
      } else {
        // No WiFi - prompt to connect
        showAlert(translate("ota:updateAvailable", {deviceName}), translate("ota:updateConnectWifi", {deviceName}), [
          {
            text: translate("ota:updateLater"),
            style: "cancel",
            onPress: () => setDismissedVersion(latestVersionInfo.versionCode?.toString() ?? ""),
          },
          {text: translate("ota:setupWifi"), onPress: () => push("/wifi/scan")},
        ])
      }
    })
  }, [
    glassesConnected,
    otaVersionUrl,
    buildNumber,
    glassesWifiConnected,
    dismissedVersion,
    defaultWearable,
    setDismissedVersion,
    pathname,
  ])

  return null
}
