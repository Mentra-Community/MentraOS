import {useEffect, useState} from "react"

import "@/shared/channels"
import {RouterProvider, useRouter} from "@/ui/router"
import {NavigationPage} from "@/ui/pages/NavigationPage/NavigationPage"
import {AddPlacePage} from "@/ui/pages/AddPlacePage"
import {SettingsPage} from "@/ui/pages/SettingsPage"
import {getGoogleMaps} from "@/ui/lib/googleMaps"
import {ToastProvider} from "@/ui/components/Toast/Toast"

function Pages() {
  const {route, pop} = useRouter()
  const [savedPlacesVersion, setSavedPlacesVersion] = useState(0)

  // No AnimatePresence wrapper. iOS WKWebView owns the back-swipe
  // animation natively — its snapshot at the moment of history.pushState
  // is the previous route (the home map), so swiping AddPlace back slides
  // it off and reveals the home screen for free. Wrapping with
  // AnimatePresence and adding a motion `exit` produced a double slide:
  // iOS slid the live AddPlace off, then AnimatePresence kept AddPlace
  // mounted long enough to play its own exit transition on top. Just
  // mount/unmount the route — the entry slide from motion still plays
  // on first mount.
  return (
    <>
      <NavigationPage savedPlacesVersion={savedPlacesVersion} />
      {route.name === "add-place" ? (
        <AddPlacePage
          presetType={route.presetType}
          onSave={async (place, name, type) => {
            const saved = {
              ...place,
              ...(name ? {savedName: name} : {}),
              ...(type ? {type} : {}),
            }
            await mentra.request("storage:add-saved", saved)
            setSavedPlacesVersion((v) => v + 1)
            pop()
          }}
          onClose={pop}
        />
      ) : null}
      {route.name === "settings" ? <SettingsPage onClose={pop} /> : null}
    </>
  )
}

export default function App() {
  // Kick off the Google Maps JS API load as soon as the tree mounts.
  // getGoogleMaps() is the singleton initialiser — first call kicks off
  // the script tag, subsequent calls are no-ops. It also pumps the
  // resulting ready/error state into the navStore so NavMap can render.
  useEffect(() => {
    getGoogleMaps()
  }, [])

  return (
    <ToastProvider>
      <RouterProvider>
        <Pages />
      </RouterProvider>
    </ToastProvider>
  )
}
