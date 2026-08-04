import {AppState, Platform} from "react-native"
import CrustModule from "@mentra/crust"

import showAlert from "@/utils/AlertUtils"

import {checkPermissionAfterSettingsReturn} from "./notificationPermissionFlow"

export type NotificationAccessRequestResult = "granted" | "denied" | "cancelled"

export async function checkAndRequestNotificationAccessSpecialPermission(): Promise<NotificationAccessRequestResult> {
  if (Platform.OS !== "android") {
    return "denied"
  }

  let hasAccess = await CrustModule.hasNotificationListenerPermission()
  if (hasAccess) {
    console.log("Notification access already granted")
    return "granted"
  }

  return await new Promise<NotificationAccessRequestResult>((resolve) => {
    let settled = false

    const finish = (result: NotificationAccessRequestResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const openSettings = async () => {
      try {
        const granted = await checkPermissionAfterSettingsReturn(
          () => CrustModule.openNotificationListenerSettings(),
          () => CrustModule.hasNotificationListenerPermission(),
          (listener) => AppState.addEventListener("change", listener),
        )
        if (granted) {
          await CrustModule.refreshNotificationListener()
        }
        finish(granted ? "granted" : "denied")
      } catch (error) {
        console.error("Error completing notification settings request:", error)
        showAlert(
          "Error",
          "Could not open notification settings. Please enable notification access manually in your device settings.",
          [{text: "OK"}],
        )
        finish("denied")
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
          onPress: () => finish("cancelled"),
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
