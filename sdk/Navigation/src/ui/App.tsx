import {useEffect, useState} from "react"
import {AnimatePresence} from "motion/react"

import "@/shared/channels"
import {RouterProvider, useRouter} from "@/ui/router"
import {NavigationPage} from "@/ui/pages/NavigationPage/NavigationPage"
import {AddPlacePage} from "@/ui/pages/AddPlacePage"
import {getGoogleMaps} from "@/ui/lib/googleMaps"

function Pages() {
  const {route, pop} = useRouter()
  const [savedPlacesVersion, setSavedPlacesVersion] = useState(0)

  return (
    <>
      <NavigationPage savedPlacesVersion={savedPlacesVersion} />
      <AnimatePresence>
        {route.name === "add-place" ? (
          <AddPlacePage
            key="add-place"
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
      </AnimatePresence>
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
    <RouterProvider>
      <Pages />
    </RouterProvider>
  )
}
