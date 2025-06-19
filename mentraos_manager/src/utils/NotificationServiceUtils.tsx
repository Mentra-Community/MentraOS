import {Alert, NativeModules, Platform} from "react-native"
import showAlert from "./AlertUtils"

const {NotificationAccess} = NativeModules

export async function checkNotificationAccessSpecialPermission() {
  if (Platform.OS !== "android") {
    return false
  }

  return await NotificationAccess.hasNotificationAccess()
}

export async function checkAndRequestNotificationAccessSpecialPermission() {
  if (Platform.OS !== "android") {
    return
  }

  try {
    const hasAccess = await NotificationAccess.hasNotificationAccess()
    if (!hasAccess) {
      await showAlert(
        "Enable Notification Access",
        "MentraOS needs permission to read your phone notifications to display them on your smart glasses.\n\n" +
          "On the next screen:\n" +
          '1. Find "MentraOS Manager" in the list\n' +
          "2. Toggle the switch to ON\n" +
          "3. Tap ALLOW when prompted",
        [
          {
            text: "Later",
            style: "cancel",
          },
          {
            text: "Go to Settings",
            onPress: () => {
              NotificationAccess.requestNotificationAccess()
                .then(() => {
                  console.log("Notification access settings opened successfully")
                })
                .catch((err: any) => {
                  console.error("Error opening notification settings:", err)
                  showAlert(
                    "Error",
                    "Could not open notification settings. Please enable notification access manually in your device settings.",
                    [{text: "OK"}],
                  )
                })
            },
          },
        ],
        {cancelable: true},
      )
    } else {
      console.log("Notification access already granted")
      return true
    }
    return false
  } catch (error) {
    console.error("Failed to check notification listener permission:", error)
    showAlert("Error", "There was a problem checking notification permissions. Please try again later.", [{text: "OK"}])
    return false
  }
}
