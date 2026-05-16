import {useState} from "react"
import {AnimatePresence} from "motion/react"

import {RouterProvider, useRouter} from "@/frontend/router"
import {NavigationPage} from "@/frontend/pages/NavigationPage/NavigationPage"
import {AddPlacePage} from "@/frontend/pages/AddPlacePage"
import {useUser} from "@/backend/hooks/useUser"

function Pages() {
  const {route, pop} = useRouter()
  const user = useUser()
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
              await user.storage.addSavedPlace(saved)
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
