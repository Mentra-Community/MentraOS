/**
 * useUser
 *
 * The single React entry point for the app. Returns the User singleton,
 * subscribed via `useSyncExternalStore` so any change to its reactive
 * properties (`coords`, `heading`, `mapsReady`, ...) re-renders the
 * calling component.
 *
 *   const user = useUser()
 *
 *   user.coords        // reactive — re-renders on GPS update
 *   user.heading       // reactive — re-renders on compass update
 *   user.mapsReady     // reactive
 *
 *   user.navigation    // imperative — start/stop/deviate/format
 *   user.display       // imperative — showText/showCard/clear
 */

import {useSyncExternalStore} from "react"

import {User} from "@/backend/session/User"

export function useUser(): User {
  const user = User.getInstance()
  useSyncExternalStore(user.subscribe, user.getSnapshot, user.getSnapshot)
  return user
}
