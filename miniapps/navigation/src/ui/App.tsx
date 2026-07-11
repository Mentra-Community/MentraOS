import {useEffect, useState} from "react"
import {useColorScheme} from "@mentra/miniapp/ui"

import "@/shared/channels"
import {RouterProvider, useRouter} from "@/ui/router"
import {NavigationPage} from "@/ui/pages/NavigationPage/NavigationPage"
import {AddPlacePage} from "@/ui/pages/AddPlacePage"
import {SettingsPage} from "@/ui/pages/SettingsPage"
import {getMapbox} from "@/ui/lib/mapbox"
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
  // Follow the host-reported color scheme (window.MentraOS.colorScheme) by
  // toggling the `.dark` class on <html>, which drives the `dark:` variants.
  const scheme = useColorScheme()
  useEffect(() => {
    document.documentElement.classList.toggle("dark", scheme === "dark")
  }, [scheme])

  // Kick off Mapbox GL JS init as soon as the tree mounts. getMapbox() is
  // the singleton initialiser — first call resolves the token and sets
  // mapboxgl.accessToken; subsequent calls are no-ops. NavMap awaits the
  // same singleton's whenReady() before constructing its map.
  useEffect(() => {
    getMapbox()
  }, [])

  return (
    <ToastProvider>
      <RouterProvider>
        <Pages />
      </RouterProvider>
    </ToastProvider>
  )
}
