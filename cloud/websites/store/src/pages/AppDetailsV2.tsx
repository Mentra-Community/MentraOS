/* eslint-disable @typescript-eslint/no-unused-vars */
import {useState, useEffect} from "react"
import {useParams, useNavigate, useLocation} from "react-router-dom"
import {useAuth} from "@mentra/shared"
import {useTheme} from "../hooks/useTheme"
import {useIsDesktop} from "../hooks/useMediaQuery"
import {usePlatform} from "../hooks/usePlatform"
import api from "../api"
import {AppI} from "../types"
import {toast} from "sonner"
import {formatCompatibilityError} from "../utils/errorHandling"
import Header_v2 from "../components/Header_v2"
import SkeletonAppDetails from "../components/SkeletonAppDetails"
import AppDetailsMobile from "./AppDetailsMobile"
import AppDetailsDesktop from "./AppDetailsDesktop"

// Extend window interface for React Native WebView
declare global {
  interface Window {
    ReactNativeWebView?: {
      postMessage: (message: string) => void
    }
  }
}

const AppDetails: React.FC = () => {
  const {packageName} = useParams<{packageName: string}>()
  const navigate = useNavigate()
  const location = useLocation()
  const {isAuthenticated} = useAuth()
  const {theme} = useTheme()
  const isDesktop = useIsDesktop()
  const {isWebView} = usePlatform()
  const [activeTab, setActiveTab] = useState<"description" | "permissions" | "hardware" | "contact" | "">("description")

  // Smart navigation function
  const handleBackNavigation = () => {
    // Check if we have history to go back to
    const canGoBack = window.history.length > 1

    // Check if the referrer is from the same domain
    const referrer = document.referrer
    const currentDomain = window.location.hostname

    if (canGoBack && referrer) {
      try {
        const referrerUrl = new URL(referrer)
        // If the referrer is from the same domain, go back
        if (referrerUrl.hostname === currentDomain) {
          navigate(-1)
          return
        }
      } catch (e) {
        // If parsing fails, fall through to navigate home
      }
    }

    // Otherwise, navigate to the homepage
    navigate("/")
  }

  const [app, setApp] = useState<AppI | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [installingApp, setInstallingApp] = useState<boolean>(false)

  // Fetch app details on component mount
  useEffect(() => {
    if (packageName) {
      fetchAppDetails(packageName)
    }
  }, [packageName, isAuthenticated])

  /**
   * Navigates to the app store filtered by the given organization ID
   * @param orgId Organization ID to filter by
   */
  const navigateToOrgApps = (orgId: string) => {
    navigate(`/?orgId=${orgId}`)
  }

  // Fetch app details and install status
  const fetchAppDetails = async (pkgName: string) => {
    try {
      setIsLoading(true)
      setError(null)

      // Get app details
      const appDetails = await api.app.getAppByPackageName(pkgName)
      console.log("Raw app details from API:", appDetails)

      if (!appDetails) {
        setError("App not found")
        return
      }

      // If authenticated, check if app is installed
      if (isAuthenticated) {
        try {
          // Get user's installed apps
          const installedApps = await api.app.getInstalledApps()

          // Check if this app is installed
          const isInstalled = installedApps.some((app) => app.packageName === pkgName)

          // Update app with installed status
          appDetails.isInstalled = isInstalled

          if (isInstalled) {
            // Find installed date from the installed apps
            const installedApp = installedApps.find((app) => app.packageName === pkgName)
            if (installedApp && installedApp.installedDate) {
              appDetails.installedDate = installedApp.installedDate
            }
          }
        } catch (err) {
          console.error("Error checking install status:", err)
          // Continue with app details, but without install status
        }
      }

      setApp(appDetails)
    } catch (err) {
      console.error("Error fetching app details:", err)
      setError("Failed to load app details. Please try again.")
    } finally {
      setIsLoading(false)
    }
  }

  // Handle app installation
  const handleInstall = async () => {
    if (!isAuthenticated) {
      navigate("/login")
      return
    }

    if (!app) return

    // Use the web API
    try {
      setInstallingApp(true)

      const success = await api.app.installApp(app.packageName)

      if (success) {
        toast.success("App installed successfully")
        setApp((prev) =>
          prev
            ? {
                ...prev,
                isInstalled: true,
                installedDate: new Date().toISOString(),
              }
            : null,
        )
      } else {
        toast.error("Failed to install app")
      }
    } catch (err) {
      console.error("Error installing app:", err)

      // Try to get a more informative error message for compatibility issues
      const compatibilityError = formatCompatibilityError(err)
      if (compatibilityError) {
        toast.error(compatibilityError, {
          duration: 6000, // Show longer for detailed messages
        })
      } else {
        // Fallback to generic error message
        const errorMessage =
          (err as {response?: {data?: {message?: string}}})?.response?.data?.message || "Failed to install app"
        toast.error(errorMessage)
      }
    } finally {
      setInstallingApp(false)
    }
  }

  // Handle app uninstallation
  const handleUninstall = async () => {
    if (!isAuthenticated || !app) return

    try {
      setInstallingApp(true)

      // Uninstall the app
      console.log("Uninstalling app:", app.packageName)
      const uninstallSuccess = await api.app.uninstallApp(app.packageName)

      if (uninstallSuccess) {
        toast.success("App uninstalled successfully")
        setApp((prev) => (prev ? {...prev, isInstalled: false, installedDate: undefined} : null))
      } else {
        toast.error("Failed to uninstall app")
      }
    } catch (err) {
      console.error("Error uninstalling app:", err)
      toast.error("Failed to uninstall app. Please try again.")
    } finally {
      setInstallingApp(false)
    }
  }

  // Navigate to login with return path
  const navigateToLogin = () => {
    navigate("/login", {
      state: {returnTo: location.pathname},
    })
  }

  return (
    <>
      {/* Header - Show on all screens EXCEPT webview */}
      {!isWebView && (
        <div className="sticky top-0 z-0">
          <Header_v2 />
        </div>
      )}

      <div
        className="min-h-screen"
        style={{
          backgroundColor: "var(--bg-primary)",
          color: "var(--text-primary)",
        }}>
        {/* Error state */}
        {!isLoading && error && <div className="text-red-500 p-4">{error}</div>}

        {/* Loading state - Skeleton */}
        {isLoading && <SkeletonAppDetails />}

        {/* Main content - Route to mobile or desktop */}
        {!isLoading && !error && app && (
          <>
            {isDesktop ? (
              <AppDetailsDesktop
                app={app}
                theme={theme}
                isAuthenticated={isAuthenticated}
                isWebView={isWebView}
                installingApp={installingApp}
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                handleBackNavigation={handleBackNavigation}
                handleInstall={handleInstall}
                handleUninstall={handleUninstall}
                navigateToLogin={navigateToLogin}
              />
            ) : (
              <AppDetailsMobile
                app={app}
                theme={theme}
                isAuthenticated={isAuthenticated}
                isWebView={isWebView}
                installingApp={installingApp}
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                handleBackNavigation={handleBackNavigation}
                handleInstall={handleInstall}
                handleUninstall={handleUninstall}
                navigateToLogin={navigateToLogin}
              />
            )}
          </>
        )}
      </div>
    </>
  )
}

export default AppDetails
