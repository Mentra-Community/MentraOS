import {ImageSourcePropType} from "react-native"
import {AppInfo} from "../MentraOSStatusParser"

// Default fallback icon
export const DEFAULT_ICON = require("../assets/app-icons/navigation.png")

export const getAppImage = (app: AppInfo): ImageSourcePropType => {
  // First, check for specific package name mappings
  switch (app.packageName) {
    case "com.mentra.merge":
      return require("../assets/app-icons/mentra-merge.png")
    case "com.mentra.link":
      return require("../assets/app-icons/mentra-link.png")
    case "com.mentra.adhdaid":
      return require("../assets/app-icons/ADHD-aid.png")
    case "com.mentra.live-translation":
    case "com.mentra.livetranslation":
      return require("../assets/app-icons/translation.png")
    case "com.example.placeholder":
    case "com.mentra.screenmirror":
      return require("../assets/app-icons/screen-mirror.png")
    case "com.mentra.livecaptions":
      return require("../assets/app-icons/captions.png")
    case "com.mentra.miraai":
      return require("../assets/app-icons/mira-ai.png")
    case "com.google.android.apps.maps":
    case "com.mentra.navigation":
      return require("../assets/app-icons/navigation.png")
    case "com.mentra.teleprompter":
      return require("../assets/app-icons/teleprompter.png")
    case "com.mentra.notify":
      return require("../assets/app-icons/phone-notifications.png")
  }

  // If an icon URL exists, return it with fallback handling
  if (app.icon) {
    return {
      uri: app.icon,
      // Provide a default icon to use if the network image fails
      cache: "force-cache", // Optionally cache the image
    }
  }

  // Final fallback to default icon
  return DEFAULT_ICON
}
