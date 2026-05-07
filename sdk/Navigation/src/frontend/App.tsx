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
            initial={route.initial}
            onSave={async (type, place, name) => {
              const saved = name ? {...place, savedName: name} : place
              if (type === "home") await user.storage.setHome(saved)
              else if (type === "work") await user.storage.setWork(saved)
              else if (type === "favorite") await user.storage.addFavorite(saved)
              else if (type === "custom") await user.storage.addCustomPlace(saved)
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
