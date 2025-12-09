import React, {useState, useEffect, useCallback, useMemo, useRef} from "react"
import {useNavigate, useSearchParams} from "react-router-dom"
import {X, Building} from "lucide-react"
import {motion, AnimatePresence} from "framer-motion"
import {useAuth} from "@mentra/shared"
import {useTheme} from "../hooks/useTheme"
import {useSearch} from "../contexts/SearchContext"
import {useProfileDropdown} from "../contexts/ProfileDropdownContext"
import {usePlatform} from "../hooks/usePlatform"
import SearchBar from "../components/SearchBar"
import api, {AppFilterOptions} from "../api"
import {AppI} from "../types"
import Header from "../components/Header_v2"
import AppCard from "../components/AppCard"
import SkeletonAppCard from "../components/SkeletonAppCard"
import SkeletonSlider from "../components/SkeletonSlider"
import {toast} from "sonner"
import {formatCompatibilityError} from "../utils/errorHandling"
import {CaptionsSlideMobile, MergeSlideMobile, StreamSlideMobile, XSlideMobile} from "../components/ui/slides"
import {ProfileDropdown} from "../components/ProfileDropdown"

/**
 * Mobile-optimized AppStore component
 */
const AppStoreMobile: React.FC = () => {
  const navigate = useNavigate()
  const {isAuthenticated, supabaseToken, coreToken, isLoading: authLoading} = useAuth()
  const {theme} = useTheme()
  const {isWebView} = usePlatform()
  const profileDropdown = useProfileDropdown()
  const [searchParams, setSearchParams] = useSearchParams()

  // Get organization ID from URL query parameter
  const orgId = searchParams.get("orgId")

  const {searchQuery, setSearchQuery} = useSearch()
  const [isLoading, setIsLoading] = useState(true)
  const [slidesLoaded, setSlidesLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [apps, setApps] = useState<AppI[]>([])
  const [originalApps, setOriginalApps] = useState<AppI[]>([])
  const [installingApp, setInstallingApp] = useState<string | null>(null)
  const [activeOrgFilter, setActiveOrgFilter] = useState<string | null>(orgId)
  const [orgName, setOrgName] = useState<string>("")

  // Slideshow state - mobile slides only
  const slideComponents = [CaptionsSlideMobile, MergeSlideMobile, StreamSlideMobile, XSlideMobile]
  const [currentSlide, setCurrentSlide] = useState(1) // Start at 1 to account for cloned slide
  const [isTransitioning, setIsTransitioning] = useState(true)
  const slideIntervalRef = useRef<NodeJS.Timeout | null>(null)

  // Helper function to check if authentication tokens are ready
  const isAuthTokenReady = () => {
    if (!isAuthenticated) return true
    return !authLoading && (supabaseToken || coreToken)
  }

  // Reset the auto-play timer
  const resetAutoPlayTimer = useCallback(() => {
    if (slideIntervalRef.current) {
      clearInterval(slideIntervalRef.current)
    }
    slideIntervalRef.current = setInterval(() => {
      setCurrentSlide((prev) => prev + 1)
    }, 8000)
  }, [])

  // Slideshow navigation functions with infinite scroll
  const goToNextSlide = useCallback(() => {
    setCurrentSlide((prev) => prev + 1)
    resetAutoPlayTimer()
  }, [resetAutoPlayTimer])

  const goToPrevSlide = useCallback(() => {
    setCurrentSlide((prev) => prev - 1)
    resetAutoPlayTimer()
  }, [resetAutoPlayTimer])

  const goToSlide = useCallback(
    (index: number) => {
      setCurrentSlide(index)
      resetAutoPlayTimer()
    },
    [resetAutoPlayTimer],
  )

  // Handle looping back to the real slides after transition completes
  useEffect(() => {
    if (currentSlide === slideComponents.length + 1) {
      // We've reached the clone at the end, jump back to start (index 1) without animation
      setTimeout(() => {
        setIsTransitioning(false)
        setCurrentSlide(1)
        setTimeout(() => setIsTransitioning(true), 50)
      }, 400) // Match transition duration
    } else if (currentSlide === 0) {
      // We've reached the clone at the start, jump to end (last real slide) without animation
      setTimeout(() => {
        setIsTransitioning(false)
        setCurrentSlide(slideComponents.length)
        setTimeout(() => setIsTransitioning(true), 50)
      }, 400) // Match transition duration
    }
  }, [currentSlide, slideComponents.length])

  // Set slides as loaded after a short delay
  useEffect(() => {
    const timer = setTimeout(() => {
      setSlidesLoaded(true)
    }, 500)

    return () => clearTimeout(timer)
  }, [])

  // Auto-play slideshow
  useEffect(() => {
    slideIntervalRef.current = setInterval(() => {
      goToNextSlide()
    }, 8000)

    return () => {
      if (slideIntervalRef.current) {
        clearInterval(slideIntervalRef.current)
      }
    }
  }, [goToNextSlide])

  // Fetch apps on component mount or when org filter changes
  useEffect(() => {
    setActiveOrgFilter(orgId)

    if (isAuthTokenReady()) {
      fetchApps()
    }
  }, [isAuthenticated, supabaseToken, coreToken, authLoading, orgId])

  /**
   * Fetches available apps and installed status
   */
  const fetchApps = async () => {
    try {
      setIsLoading(true)
      setError(null)

      let appList: AppI[] = []
      let installedApps: AppI[] = []

      try {
        const filterOptions: AppFilterOptions = {}
        if (orgId) {
          filterOptions.organizationId = orgId
        }

        appList = await api.app.getAvailableApps(orgId ? filterOptions : undefined)

        if (orgId && appList.length > 0) {
          const firstApp = appList[0]
          if (firstApp.orgName) {
            setOrgName(firstApp.orgName)
          } else {
            setOrgName("Selected Organization")
          }
        }
      } catch {
        setError("Failed to load apps. Please try again.")
        return
      }

      if (isAuthenticated) {
        try {
          installedApps = await api.app.getInstalledApps()

          const installedMap = new Map<string, boolean>()
          installedApps.forEach((app) => {
            installedMap.set(app.packageName, true)
          })

          appList = appList.map((app) => ({
            ...app,
            isInstalled: installedMap.has(app.packageName),
          }))

          console.log("Merged apps with install status:", appList)
        } catch (err) {
          console.error("Error fetching installed apps:", err)
        }
      }

      setApps(appList)
      setOriginalApps(appList)
    } catch (err) {
      console.error("Error fetching apps:", err)
      setError("Failed to load apps. Please try again.")
    } finally {
      setIsLoading(false)
    }
  }

  // Filter apps based on search query
  const filteredApps = useMemo(() => {
    if (searchQuery.trim() === "") return apps

    const query = searchQuery.toLowerCase()
    const filtered = apps.filter(
      (app) =>
        app.name.toLowerCase().includes(query) ||
        (app.description && app.description.toLowerCase().includes(query)) ||
        app.packageName.toLowerCase().includes(query),
    )

    if (apps.length === 1 && apps !== originalApps) {
      return apps
    }

    return filtered
  }, [apps, originalApps, searchQuery])

  /**
   * Handles search form submission
   */
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!searchQuery.trim()) {
      fetchApps()
      return
    }

    try {
      setIsLoading(true)
      setError(null)

      const filterOptions: AppFilterOptions = {}
      if (orgId) {
        filterOptions.organizationId = orgId
      }

      const results = await api.app.searchApps(searchQuery, orgId ? filterOptions : undefined)

      if (isAuthenticated && isAuthTokenReady()) {
        try {
          const installedApps = await api.app.getInstalledApps()

          const installedMap = new Map<string, boolean>()
          installedApps.forEach((app) => {
            installedMap.set(app.packageName, true)
          })

          results.forEach((app) => {
            app.isInstalled = installedMap.has(app.packageName)
          })
        } catch (err) {
          console.error("Error updating search results with install status:", err)
        }
      }

      setApps(results)
    } catch (err) {
      console.error("Error searching apps:", err)
      toast.error("Failed to search apps")
      setError("Failed to search apps. Please try again.")
    } finally {
      setIsLoading(false)
    }
  }

  /**
   * Clears the organization filter
   */
  const clearOrgFilter = () => {
    setSearchParams((prev) => {
      const newParams = new URLSearchParams(prev)
      newParams.delete("orgId")
      return newParams
    })
    setActiveOrgFilter(null)
    setOrgName("")
  }

  // Handle app installation
  const handleInstall = useCallback(
    async (packageName: string) => {
      if (!isAuthenticated) {
        navigate("/login")
        return
      }

      try {
        setInstallingApp(packageName)

        const success = await api.app.installApp(packageName)

        if (success) {
          toast.success("App installed successfully")

          setApps((prevApps) =>
            prevApps.map((app) =>
              app.packageName === packageName
                ? {
                    ...app,
                    isInstalled: true,
                    installedDate: new Date().toISOString(),
                  }
                : app,
            ),
          )
        } else {
          toast.error("Failed to install app")
        }
      } catch (err) {
        console.error("Error installing app:", err)

        const compatibilityError = formatCompatibilityError(err)
        if (compatibilityError) {
          toast.error(compatibilityError, {
            duration: 6000,
          })
        } else {
          const errorMessage =
            (err as {response?: {data?: {message?: string}}})?.response?.data?.message || "Failed to install app"
          toast.error(errorMessage)
        }
      } finally {
        setInstallingApp(null)
      }
    },
    [isAuthenticated, navigate],
  )

  // Handle app uninstallation
  const handleUninstall = useCallback(
    async (packageName: string) => {
      if (!isAuthenticated) {
        navigate("/login")
        return
      }

      try {
        console.log("Uninstalling app:", packageName)
        setInstallingApp(packageName)

        const success = await api.app.uninstallApp(packageName)

        if (success) {
          toast.success("App uninstalled successfully")

          setApps((prevApps) =>
            prevApps.map((app) =>
              app.packageName === packageName ? {...app, isInstalled: false, installedDate: undefined} : app,
            ),
          )
        } else {
          toast.error("Failed to uninstall app")
        }
      } catch (err) {
        console.error("Error uninstalling app:", err)
        toast.error("Failed to uninstall app")
      } finally {
        setInstallingApp(null)
      }
    },
    [isAuthenticated, navigate],
  )

  const handleCardClick = useCallback(
    (packageName: string) => {
      navigate(`/package/${packageName}`)
    },
    [navigate],
  )

  const handleLogin = useCallback(() => {
    navigate("/login")
  }, [navigate])

  const handleSearchChange = useCallback(
    async (value: string) => {
      setSearchQuery(value)

      if (apps !== originalApps) {
        setApps(originalApps)
      }

      if (value.trim() === "") {
        return
      }

      const query = value.toLowerCase()
      const filtered = originalApps.filter(
        (app) =>
          app.name.toLowerCase().includes(query) || (app.description && app.description.toLowerCase().includes(query)),
      )

      if (filtered.length === 0) {
        setIsLoading(true)
        try {
          const pkgApp = await api.app.getAppByPackageName(value)

          if (pkgApp) {
            if (isAuthenticated && isAuthTokenReady()) {
              try {
                const installedApps = await api.app.getInstalledApps()
                pkgApp.isInstalled = installedApps.some((app) => app.packageName === pkgApp.packageName)
                console.log(`App install status: ${pkgApp.isInstalled ? "INSTALLED" : "NOT INSTALLED"}`)
              } catch (error) {
                console.error("Error checking install status:", error)
                pkgApp.isInstalled = false
              }
            } else {
              pkgApp.isInstalled = false
            }

            setApps([pkgApp])
          }
        } catch {
          // Silent fail
        } finally {
          setIsLoading(false)
        }
      }
    },
    [apps, originalApps, isAuthenticated, isAuthTokenReady],
  )

  return (
    <div
      className="min-h-screen text-white"
      style={{
        backgroundColor: "var(--bg-primary)",
        color: "var(--text-primary)",
      }}>
      {/* Header */}
      <Header
        onSearch={handleSearch}
        onSearchClear={() => {
          setSearchQuery("")
          fetchApps()
        }}
      />

      {/* Search bar - sticky at top on mobile */}
      <div
        className="sticky top-0 z-20 px-[24px] py-[24px]"
        style={{
          backgroundColor: "var(--bg-primary)",
        }}>
        <SearchBar
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          onSearchSubmit={handleSearch}
          onClear={() => {
            setSearchQuery("")
            fetchApps()
          }}
          className="w-full"
        />
      </div>

      {/* Profile dropdown - only show on mobile non-webview when authenticated */}
      {!isWebView && isAuthenticated && (
        <AnimatePresence>
          {profileDropdown.isOpen && (
            <>
              {/* Backdrop */}
              <motion.div
                initial={{opacity: 0}}
                animate={{opacity: 1}}
                exit={{opacity: 0}}
                transition={{duration: 0.2}}
                className="fixed inset-0 bg-black/20 z-40"
                onClick={() => profileDropdown.setIsOpen(false)}
              />

              {/* Dropdown Content */}
              <motion.div
                initial={{opacity: 0, y: -10}}
                animate={{opacity: 1, y: 0}}
                exit={{opacity: 0, y: -10}}
                transition={{duration: 0.2}}
                className="fixed top-[85px] left-[24px] right-[24px] z-50">
                <ProfileDropdown variant="mobile" />
              </motion.div>
            </>
          )}
        </AnimatePresence>
      )}

      <main className="px-[24px] pb-6">
        {/* Organization filter indicator */}
        {activeOrgFilter && (
          <div className="my-2 max-w-2xl mx-auto px-4">
            <div
              className="flex items-center text-sm px-3 py-2 rounded-md"
              style={{
                backgroundColor: theme === "light" ? "#dbeafe" : "var(--bg-secondary)",
                color: theme === "light" ? "#1e40af" : "var(--text-secondary)",
                border: `1px solid ${theme === "light" ? "#93c5fd" : "var(--border-color)"}`,
              }}>
              <Building className="h-4 w-4 mr-2" />
              <span>
                Filtered by: <span className="font-medium">{orgName || "Organization"}</span>
              </span>
              <button
                onClick={clearOrgFilter}
                className="ml-auto hover:opacity-70 transition-opacity"
                style={{
                  color: theme === "light" ? "#1e40af" : "var(--text-secondary)",
                }}
                aria-label="Clear organization filter">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {/* Error message */}
        {error && !isLoading && (
          <div className="max-w-2xl mx-auto px-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
            <p>{error}</p>
            <button className="mt-2 text-sm font-medium text-red-700 hover:text-red-600" onClick={fetchApps}>
              Try Again
            </button>
          </div>
        )}

        {/* Slideshow Section - Hidden when searching */}
        {!searchQuery && (
          <div className="">
            {!slidesLoaded ? (
              <SkeletonSlider />
            ) : (
              <div
                className="w-full relative overflow-hidden touch-pan-y "
                onTouchStart={(e) => {
                  const touch = e.touches[0]
                  const target = e.currentTarget as HTMLDivElement & {
                    startX?: number
                    startTime?: number
                  }
                  target.startX = touch.clientX
                  target.startTime = Date.now()
                }}
                onTouchEnd={(e) => {
                  const touch = e.changedTouches[0]
                  const target = e.currentTarget as HTMLDivElement & {
                    startX?: number
                    startTime?: number
                  }
                  const startX = target.startX || 0
                  const startTime = target.startTime || Date.now()
                  const diff = touch.clientX - startX
                  const timeDiff = Date.now() - startTime
                  const velocity = Math.abs(diff) / timeDiff

                  const isSwipe = velocity > 0.5
                  const threshold = isSwipe ? 30 : 80

                  if (diff < -threshold) {
                    goToNextSlide()
                  } else if (diff > threshold) {
                    goToPrevSlide()
                  }
                }}>
                {/* Slides Container */}
                <motion.div
                  className="flex"
                  animate={{x: `-${currentSlide * 100}%`}}
                  transition={
                    isTransitioning
                      ? {
                          type: "tween",
                          duration: 0.4,
                          ease: [0.25, 0.1, 0.25, 1],
                        }
                      : {duration: 0}
                  }>
                  {/* Clone of last slide for seamless loop */}
                  {slideComponents[slideComponents.length - 1] &&
                    React.createElement(slideComponents[slideComponents.length - 1], {
                      key: "clone-last",
                    })}
                  {/* Actual slides */}
                  {slideComponents.map((SlideComponent, index) => (
                    <SlideComponent key={index} />
                  ))}
                  {/* Clone of first slide for seamless loop */}
                  {slideComponents[0] && React.createElement(slideComponents[0], {key: "clone-first"})}
                </motion.div>

                {/* Slide Indicators */}
                <div className="absolute top-[10px] left-1/2 -translate-x-1/2 flex gap-2 z-1">
                  {slideComponents.map((_, index) => {
                    // Calculate actual slide index accounting for cloned slides
                    const actualIndex =
                      currentSlide === 0
                        ? slideComponents.length - 1
                        : currentSlide === slideComponents.length + 1
                          ? 0
                          : currentSlide - 1
                    return (
                      <motion.button
                        key={index}
                        onClick={() => goToSlide(index + 1)} // Add 1 to account for cloned slide
                        className={`rounded-full h-[2px] ${
                          index === actualIndex ? "bg-white" : "bg-white/50 hover:bg-white/75"
                        }`}
                        aria-label={`Go to slide ${index + 1}`}
                        animate={{
                          width: index === actualIndex ? 32 : 8,
                        }}
                        transition={{duration: 0.3}}
                        whileHover={{scale: 1.2}}
                      />
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {!searchQuery && (
          <div className="text-[20px] mt-[24px] mb-[24px] font-semibold text-[var(--secondary-foreground)] leading-tight">
            Top Apps
          </div>
        )}

        {/* App grid with loading skeletons */}
        <div className="">
          {isLoading ? (
            <div className="mb-2 grid grid-cols-1 gap-y-6">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <SkeletonAppCard key={i} />
              ))}
            </div>
          ) : !error ? (
            <div className="mt-2 mb-2 grid grid-cols-1 gap-y-[24px]">
              {filteredApps.map((app) => (
                <AppCard
                  key={app.packageName}
                  app={app}
                  theme={theme}
                  isAuthenticated={isAuthenticated}
                  installingApp={installingApp}
                  onInstall={handleInstall}
                  onUninstall={handleUninstall}
                  onCardClick={handleCardClick}
                  onLogin={handleLogin}
                  isLastRow={false}
                />
              ))}
            </div>
          ) : null}
        </div>

        {/* Empty state */}
        {!isLoading && !error && filteredApps.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 px-4">
            {searchQuery ? (
              <>
                <div
                  className="mb-6 w-20 h-20 rounded-full flex items-center justify-center"
                  style={{backgroundColor: "var(--bg-secondary)"}}>
                  <svg
                    className="w-10 h-10"
                    style={{color: "var(--text-muted)"}}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                </div>

                <h3 className="text-xl font-semibold mb-2" style={{color: "var(--text-primary)"}}>
                  No apps found
                </h3>
                <p className="text-base mb-6 max-w-md text-center" style={{color: "var(--text-secondary)"}}>
                  We couldn&apos;t find any apps matching &quot;{searchQuery}&quot;
                  {activeOrgFilter && ` in ${orgName}`}
                </p>

                <motion.button
                  className="px-6 py-3 font-medium rounded-xl shadow-md transition-colors"
                  style={{
                    backgroundColor: "var(--accent-primary)",
                    color: "#ffffff",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--accent-hover)")}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "var(--accent-primary)")}
                  onClick={() => {
                    setSearchQuery("")
                    fetchApps()
                  }}
                  whileHover={{scale: 1.05}}
                  whileTap={{scale: 0.95}}>
                  Clear Search
                </motion.button>
              </>
            ) : (
              <>
                <div
                  className="mb-6 w-20 h-20 rounded-full flex items-center justify-center"
                  style={{backgroundColor: "var(--bg-secondary)"}}>
                  <svg
                    className="w-10 h-10"
                    style={{color: "var(--text-muted)"}}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
                    />
                  </svg>
                </div>
                <p className="text-lg" style={{color: "var(--text-secondary)"}}>
                  {activeOrgFilter ? `No apps available for ${orgName}.` : "No apps available at this time."}
                </p>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

export default AppStoreMobile
