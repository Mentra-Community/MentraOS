import * as WebBrowser from "expo-web-browser"
import {Platform} from "react-native"

/** Returns false when the user cancels, so the caller can leave the sign-in screen. */
export async function openAuthBrowser(url: string, processUrl: (url: string) => Promise<void>): Promise<boolean> {
  if (Platform.OS === "ios") {
    // Preserve the in-app Safari flow without the auth-session consent prompt.
    // DeeplinkProvider completes the handoff and dismisses this browser; the
    // user's Done button produces "cancel" instead of "dismiss".
    const result = await WebBrowser.openBrowserAsync(url)
    return result.type === "dismiss"
  }

  const result = await WebBrowser.openAuthSessionAsync(url, "com.mentra://auth/callback")
  if (result.type !== "success") return false

  await processUrl(result.url)
  return true
}
