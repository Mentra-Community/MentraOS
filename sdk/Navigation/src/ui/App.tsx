import {useState} from "react"
import {AnimatePresence} from "motion/react"

import "@/shared/channels"
import {RouterProvider, useRouter} from "@/ui/router"
import {NavigationPage} from "@/ui/pages/NavigationPage/NavigationPage"
import {AddPlacePage} from "@/ui/pages/AddPlacePage"

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
  return (
    <RouterProvider>
      <Pages />
    </RouterProvider>
  )
}
