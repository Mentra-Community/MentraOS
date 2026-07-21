import {AppState, Platform} from "react-native"
import CrustModule from "@mentra/crust"

import showAlert from "@/utils/AlertUtils"

import {checkPermissionAfterSettingsReturn} from "./notificationPermissionFlow"

export async function checkAndRequestNotificationAccessSpecialPermission(): Promise<boolean> {
  if (Platform.OS !== "android") {
    return false
  }

  let hasAccess = await CrustModule.hasNotificationListenerPermission()
  if (hasAccess) {
    console.log("Notification access already granted")
    return true
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false

    const finish = (granted: boolean) => {
      if (settled) return
      settled = true
      resolve(granted)
    }

    const openSettings = async () => {
      try {
        const granted = await checkPermissionAfterSettingsReturn(
          () => CrustModule.openNotificationListenerSettings(),
          () => CrustModule.hasNotificationListenerPermission(),
          (listener) => AppState.addEventListener("change", listener),
        )
        finish(granted)
      } catch (error) {
        console.error("Error completing notification settings request:", error)
        showAlert(
          "Error",
          "Could not open notification settings. Please enable notification access manually in your device settings.",
          [{text: "OK"}],
        )
        finish(false)
      }
    }

    showAlert(
      "Enable Notification Access",
      "MentraOS needs permission to read your phone notifications to display them on your smart glasses.\n\n" +
        "On the next screen:\n" +
        '1. Find "MentraOS" in the list\n' +
        '2. Toggle the switch to "on"\n' +
        '3. Tap "Allow" when prompted',
      [
        {
          text: "Later",
          style: "cancel",
          onPress: () => finish(false),
        },
        {
          text: "Go to Settings",
          onPress: openSettings,
        },
      ],
      {cancelable: true},
    )
  })
}
