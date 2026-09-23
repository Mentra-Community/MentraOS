import {useEffect, useSyncExternalStore} from "react"
import {usePathname} from "expo-router"
import {SETTINGS, useSetting} from "@mentra/engine"
import {liveAvailability, startLiveAvailability} from "@mentra/engine-host-internal"

import {translate} from "@/i18n/translate"
import {useNavigationStore} from "@/stores/navigation"
import showAlert from "@/utils/AlertUtils"

export {
  fetchVersionInfo,
  checkVersionUpdateAvailable,
  getLatestVersionInfo,
  findMatchingMtkPatch,
  checkBesUpdate,
  checkForOtaUpdate,
  getPendingUpdatePromptAction,
} from "@mentra/engine-host-internal"

/** App-only presentation. Check policy, timers and offers belong to the Live provider's monitor. */
export function OtaUpdateChecker() {
  const pathname = usePathname()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [superMode] = useSetting(SETTINGS.super_mode.key)
  const snapshot = useSyncExternalStore(
    liveAvailability.subscribe,
    liveAvailability.snapshot,
    liveAvailability.snapshot,
  )

  useEffect(() => {
    void startLiveAvailability()
    return () => liveAvailability.setHome(false)
  }, [])
  useEffect(() => {
    liveAvailability.setHome(pathname === "/home")
  }, [pathname])
  useEffect(() => {
    const prompt = snapshot.prompt
    if (pathname !== "/home" || !prompt || !liveAvailability.claimPrompt(prompt.id)) return
    const deviceName = defaultWearable || "Glasses"
    const updateList = prompt.updates.join(", ").toUpperCase()
    const message = prompt.isDowngrade
      ? translate("ota:downgradeDescriptionShort") + (superMode ? ` (${updateList})` : "")
      : superMode
      ? `Updates available: ${updateList}`
      : prompt.updates.length === 1
      ? "1 update available"
      : `${prompt.updates.length} updates available`
    const wifi = prompt.action === "wifi_setup"
    showAlert(
      translate(prompt.isDowngrade ? "ota:downgradeAvailable" : "ota:updateAvailable", {deviceName}),
      wifi ? `${message}\n\nConnect your ${deviceName} to WiFi to install.` : message,
      [
        {text: translate("ota:updateLater"), style: "cancel", onPress: () => liveAvailability.dismiss(prompt.id)},
        {
          text: translate(wifi ? "ota:setupWifi" : "ota:install"),
          onPress: () => {
            if (liveAvailability.snapshot().prompt?.id !== prompt.id) return
            useNavigationStore.getState().push(wifi ? "/wifi/scan" : "/ota/check-for-updates")
          },
        },
      ],
    )
  }, [pathname, snapshot.prompt, defaultWearable, superMode])
  return null
}
