import {AppState} from "react-native"

import {cloudClient} from "@/services/cloudClient"

/** The Mentra App came back to the foreground. Returns an unsubscribe function. */
export function subscribeAppForeground(handler: () => void): () => void {
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") handler()
  })
  return () => subscription.remove()
}

/** The cloud connection came back. Returns an unsubscribe function. */
export function subscribeCloudReconnect(handler: () => void): () => void {
  let wasConnected = cloudClient.isConnected()
  return cloudClient.onConnectionChange((connected) => {
    if (connected && !wasConnected) handler()
    wasConnected = connected
  })
}
