import CoreModule from "modules/core/src/CoreModule"
import {Linking, Platform} from "react-native"

import showAlert from "@/utils/AlertUtils"

export async function checkAndRequestNotificationAccessSpecialPermission(): Promise<boolean> {
  if (Platform.OS !== "android") {
    return false
  }

  let hasAccess = await CoreModule.hasNotificationListenerPermission()
  if (hasAccess) {
    console.log("Notification access already granted")
    return true
  }

  return await new Promise<boolean>(resolve => {
    // useFocusEffect(
    //   useCallback(() => {
    //     // let hasAccess = await CoreModule.hasNotificationListenerPermission()
    //     // if (hasAccess) {
    //     //   console.log("Notification access already granted")
    //     //   return true
    //     // }

    //     resolve(CoreModule.hasNotificationListenerPermission())
    //     return async () => {}
    //   }, []),
    // )
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
          onPress: () => {
            resolve(false)
          },
        },
        {
          text: "Go to Settings",
          onPress: async () => {
            Linking.sendIntent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS").catch((err: any) => {
              console.error("Error opening notification settings:", err)
              showAlert(
                "Error",
                "Could not open notification settings. Please enable notification access manually in your device settings.",
                [{text: "OK"}],
              )
            })
            // resolve(false)
          },
        },
      ],
      {cancelable: true},
    )
  })
}
