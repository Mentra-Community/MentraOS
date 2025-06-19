// app/index.js

import {useEffect} from "react"
import {useStatus} from "@/contexts/MentraOSStatusProvider"
import {useAuth} from "@/contexts/AuthContext"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"

export default function IndexPage() {
  const {user, loading} = useAuth()
  const {status, initializeCoreConnection} = useStatus()
  const {goBack, push, replace} = useNavigationHistory()

  useEffect(() => {
    const initializeApp = async () => {
      /*
      The purpose of SplashScreen is to route the user wherever the user needs to be
      If they're not logged in => login screen
      If they're logged in, but no perms => perm screen
      If they're logged in + perms => SimulatedPucK setup
      */
      if (!user) {
        replace("/auth/login")
        return
      }

      // We're now skipping the Grant Permissions screen completely
      // Optional permissions will be handled via the Additional Permissions screen
      // accessed through the alert icon on the homepage

      initializeCoreConnection()

      replace("/auth/core-token-exchange")
    }

    if (!loading) {
      initializeApp().catch(error => {
        console.error("Error initializing app:", error)
      })
    }
  }, [user, loading, status, initializeCoreConnection])

  // this component doesn't render anything, it's just used to initialize the app
  return null
}
