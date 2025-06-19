import React, {createContext, useContext, useState, ReactNode, useCallback, useEffect, useRef} from "react"
import BackendServerComms from "../backend_comms/BackendServerComms"
import {useAuth} from "@/contexts/AuthContext"
import {useStatus} from "./MentraOSStatusProvider"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {router} from "expo-router"
import {AppState} from "react-native"
import {loadSetting} from "@/utils/SettingsHelper"
import {SETTINGS_KEYS} from "@/consts"
import coreCommunicator from "@/bridge/CoreCommunicator"

export type TPAPermissionType =
  | "ALL"
  | "MICROPHONE"
  | "CAMERA"
  | "CALENDAR"
  | "LOCATION"
  | "READ_NOTIFICATIONS"
  | "POST_NOTIFICATIONS"
export interface TPAPermission {
  description: string
  type: TPAPermissionType
  required?: boolean
}

// Define the AppInterface based on AppI from SDK
export interface AppInterface {
  packageName: string
  name: string
  publicUrl: string
  isSystemApp?: boolean
  uninstallable?: boolean
  webviewURL?: string
  logoURL: string
  tpaType: string
  appStoreId?: string
  developerId?: string
  hashedEndpointSecret?: string
  hashedApiKey?: string
  description?: string
  version?: string
  settings?: Record<string, unknown>
  isPublic?: boolean
  appStoreStatus?: "DEVELOPMENT" | "SUBMITTED" | "REJECTED" | "PUBLISHED"
  developerProfile?: {
    company?: string
    website?: string
    contactEmail?: string
    description?: string
    logo?: string
  }
  permissions: TPAPermission[]
  is_running?: boolean
  is_foreground?: boolean
}

interface AppStatusContextType {
  appStatus: AppInterface[]
  refreshAppStatus: () => Promise<void>
  optimisticallyStartApp: (packageName: string) => void
  optimisticallyStopApp: (packageName: string) => void
  clearPendingOperation: (packageName: string) => void
  isLoading: boolean
  error: string | null
  isSensingEnabled: boolean
}

const AppStatusContext = createContext<AppStatusContextType | undefined>(undefined)

export const AppStatusProvider = ({children}: {children: ReactNode}) => {
  const [appStatus, setAppStatus] = useState<AppInterface[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const {user, logout} = useAuth()
  const {status} = useStatus()

  // Keep track of active operations to prevent race conditions
  const pendingOperations = useRef<{[packageName: string]: "start" | "stop"}>({})

  // Track when the last refresh was performed
  const lastRefreshTime = useRef<number>(0)

  const refreshAppStatus = useCallback(async () => {
    console.log("AppStatusProvider: refreshAppStatus called - user exists:", !!user, "user email:", user?.email)
    if (!user) {
      console.log("AppStatusProvider: No user, clearing app status")
      setAppStatus([])
      return Promise.resolve()
    }

    // Check if we have a core token from BackendServerComms
    const coreToken = BackendServerComms.getInstance().getCoreToken()
    console.log(
      "AppStatusProvider: Core token check - token exists:",
      !!coreToken,
      "token length:",
      coreToken?.length || 0,
    )
    if (!coreToken) {
      console.log("Waiting for core token before fetching apps")
      return Promise.resolve()
    }

    console.log("AppStatusProvider: Token check passed, starting app fetch...")
    setIsLoading(true)
    setError(null)

    // Record the time of this refresh attempt
    const refreshStartTime = Date.now()
    lastRefreshTime.current = refreshStartTime

    try {
      // Store current running states before fetching
      const currentRunningStates: {[packageName: string]: boolean} = {}
      appStatus.forEach(app => {
        if (app.is_running) {
          currentRunningStates[app.packageName] = true
        }
      })

      console.log("AppStatusProvider: Calling BackendServerComms.getApps()...")
      const appsData = await BackendServerComms.getInstance().getApps()
      console.log("AppStatusProvider: getApps() returned", appsData?.length || 0, "apps")

      // Only process this update if it's the most recent one
      if (refreshStartTime === lastRefreshTime.current) {
        // Merge existing running states with new data
        const updatedAppsData = appsData.map(app => {
          // Make a shallow copy of the app object
          const appCopy = {...app}

          // Check pending operations first
          const pendingOp = pendingOperations.current[app.packageName]
          if (pendingOp === "start") {
            appCopy.is_running = true
          } else if (pendingOp === "stop") {
            appCopy.is_running = false
          } else if (app.is_running !== undefined) {
            // If the server provided is_running status, use it
            appCopy.is_running = Boolean(app.is_running)
          } else if (currentRunningStates[app.packageName]) {
            // Fallback to our local state if server didn't provide is_running
            appCopy.is_running = true
          } else {
            // Default to not running if no information is available
            appCopy.is_running = false
          }

          return appCopy
        })

        setAppStatus(updatedAppsData)
      }
    } catch (err) {
      console.error("AppStatusProvider: Error fetching apps:", err)
      // if (("" + err).includes("401")) {
      //   // log out the user
      //   await logout()
      //   replace("/auth/login")
      // }
      setError("Error fetching apps")
    } finally {
      setIsLoading(false)
    }
  }, [user, status])

  // Optimistically update app status when starting an app
  const optimisticallyStartApp = useCallback((packageName: string) => {
    // Record that we have a pending start operation
    pendingOperations.current[packageName] = "start"

    // Set a timeout to clear this operation after 10 seconds (in case callback never happens)
    setTimeout(() => {
      if (pendingOperations.current[packageName] === "start") {
        delete pendingOperations.current[packageName]
      }
    }, 20000)

    setAppStatus(currentStatus => {
      // First update all apps' foreground status
      const updatedApps = currentStatus.map(app => ({
        ...app,
        is_foreground: app.packageName === packageName,
      }))

      // Then update the target app to be running
      return updatedApps.map(app =>
        app.packageName === packageName ? {...app, is_running: true, is_foreground: true} : app,
      )
    })
  }, [])

  // Optimistically update app status when stopping an app
  const optimisticallyStopApp = useCallback((packageName: string) => {
    // Record that we have a pending stop operation
    pendingOperations.current[packageName] = "stop"

    // Set a timeout to clear this operation after 10 seconds
    setTimeout(() => {
      if (pendingOperations.current[packageName] === "stop") {
        delete pendingOperations.current[packageName]
      }
    }, 10000)

    setAppStatus(currentStatus =>
      currentStatus.map(app => (app.packageName === packageName ? {...app, is_running: false} : app)),
    )
  }, [])

  // When an app start/stop operation succeeds, clear the pending operation
  const clearPendingOperation = useCallback((packageName: string) => {
    delete pendingOperations.current[packageName]
  }, [])

  // Initial fetch and refresh on user change or status change
  useEffect(() => {
    refreshAppStatus()
  }, [user, status])

  // Listen for app started/stopped events from CoreCommunicator
  useEffect(() => {
    const onAppStarted = (packageName: string) => {
      console.log("APP_STARTED_EVENT", packageName)
      optimisticallyStartApp(packageName)
    }
    const onAppStopped = (packageName: string) => {
      console.log("APP_STOPPED_EVENT", packageName)
      optimisticallyStopApp(packageName)
    }
    const onResetAppStatus = () => {
      console.log("RESET_APP_STATUS event received, clearing app status")
      setAppStatus([])
      setError(null)
      setIsLoading(false)
    }
    const onCoreTokenSet = () => {
      console.log("CORE_TOKEN_SET event received, forcing app refresh with 1.5 second delay")
      // Add a delay to let the token become valid on the server side
      setTimeout(() => {
        console.log("CORE_TOKEN_SET: Delayed refresh executing now")
        refreshAppStatus().catch(error => {
          console.error("CORE_TOKEN_SET: Error during delayed refresh:", error)
        })
      }, 1500)
    }
    // @ts-ignore
    GlobalEventEmitter.on("APP_STARTED_EVENT", onAppStarted)
    // @ts-ignore
    GlobalEventEmitter.on("APP_STOPPED_EVENT", onAppStopped)
    // @ts-ignore
    GlobalEventEmitter.on("RESET_APP_STATUS", onResetAppStatus)
    // @ts-ignore
    GlobalEventEmitter.on("CORE_TOKEN_SET", onCoreTokenSet)
    return () => {
      // @ts-ignore
      GlobalEventEmitter.off("APP_STARTED_EVENT", onAppStarted)
      // @ts-ignore
      GlobalEventEmitter.off("APP_STOPPED_EVENT", onAppStopped)
      // @ts-ignore
      GlobalEventEmitter.off("RESET_APP_STATUS", onResetAppStatus)
      // @ts-ignore
      GlobalEventEmitter.off("CORE_TOKEN_SET", onCoreTokenSet)
    }
  }, [optimisticallyStartApp, optimisticallyStopApp, refreshAppStatus])

  // Add a listener for app state changes to detect when the app comes back from background
  useEffect(() => {
    const handleAppStateChange = async (nextAppState: any) => {
      console.log("App state changed to:", nextAppState)
      // If app comes back to foreground, hide the loading overlay
      if (nextAppState === "active") {
        if (await loadSetting(SETTINGS_KEYS.RECONNECT_ON_APP_FOREGROUND, true)) {
          console.log("Attempt reconnect to glasses")
          if (status.core_info.default_wearable && !status.glasses_info?.model_name) {
            await coreCommunicator.sendConnectWearable("") // does nothing if not already connected to glasses, at least on ios
          }
        }
      }
    }

    // Subscribe to app state changes
    const appStateSubscription = AppState.addEventListener("change", handleAppStateChange)

    return () => {
      appStateSubscription.remove()
    }
  }, [])

  return (
    <AppStatusContext.Provider
      value={{
        appStatus,
        refreshAppStatus,
        optimisticallyStartApp,
        optimisticallyStopApp,
        clearPendingOperation,
        isLoading,
        error,
        isSensingEnabled: status.core_info.sensing_enabled,
      }}>
      {children}
    </AppStatusContext.Provider>
  )
}

export const useAppStatus = () => {
  const context = useContext(AppStatusContext)
  if (!context) {
    throw new Error("useAppStatus must be used within an AppStatusProvider")
  }
  return context
}
