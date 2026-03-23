import {useEffect} from "react"
import {initAnalytics} from "@/utils/analytics"

export const FirebaseAnalyticsSetup = () => {
  useEffect(() => {
    initAnalytics().catch((err) => console.warn("Firebase Analytics init failed:", err))
  }, [])

  return null
}
