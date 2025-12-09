import {useState, useRef, useEffect} from "react"
import {Link, useNavigate, useLocation} from "react-router-dom"
import {motion, AnimatePresence} from "framer-motion"
import {useAuth} from "@mentra/shared"
import {usePlatform} from "../hooks/usePlatform"
import {useTheme} from "../hooks/useTheme"
import {useSearch} from "../contexts/SearchContext"
import {useProfileDropdown} from "../contexts/ProfileDropdownContext"
import {Button} from "./ui/button"
import {Search, User} from "lucide-react"
import SearchBar from "./SearchBar"
import {DropDown} from "./ui/dropdown"
import {ProfileDropdown} from "./ProfileDropdown"

interface HeaderProps {
  onSearch?: (e: React.FormEvent) => void
  onSearchClear?: () => void
  onSearchChange?: (value: string) => void
}

const Header: React.FC<HeaderProps> = ({onSearch, onSearchClear, onSearchChange}) => {
  const {isAuthenticated, user} = useAuth()
  const {isWebView} = usePlatform()
  const {theme} = useTheme()
  const {searchQuery, setSearchQuery} = useSearch()
  const profileDropdown = useProfileDropdown()
  const navigate = useNavigate()
  const location = useLocation()
  const isStorePage = location.pathname === "/"
  const isAppDetailPage = location.pathname.startsWith("/package/")
  const [searchMode, setsearchMode] = useState(false)
  const searchRef = useRef<HTMLFormElement>(null)
  const [isMobile, setIsMobile] = useState(typeof window !== "undefined" ? window.innerWidth <= 639 : false)

  // Check URL params for search trigger
  useEffect(() => {
    const searchParams = new URLSearchParams(location.search)
    console.log("Checking URL for search param:", searchParams.get("search"))

    if (searchParams.get("search") === "true" && !searchMode) {
      console.log("Found search=true in URL, activating search mode")
      setsearchMode(true)

      // Clean up URL after a delay to allow focus to happen first
      setTimeout(() => {
        searchParams.delete("search")
        const newSearch = searchParams.toString()
        navigate(location.pathname + (newSearch ? `?${newSearch}` : ""), {
          replace: true,
        })
      }, 500)
    }
  }, [location.search, location.pathname, navigate, searchMode])

  // Focus search input when search mode is activated
  useEffect(() => {
    if (searchMode) {
      console.log("Search mode activated, attempting to focus input")

      // Try to focus after a short delay to ensure the input is rendered
      const timer = setTimeout(() => {
        const searchInput = searchRef.current?.querySelector("input")
        console.log("Search input element:", searchInput)

        if (searchInput instanceof HTMLInputElement) {
          searchInput.focus()
          console.log("Focus called. Active element:", document.activeElement)
          console.log("Is input focused?", document.activeElement === searchInput)
        } else {
          console.log("Search input not found or not an input element")
        }
      }, 350)

      return () => clearTimeout(timer)
    }
  }, [searchMode])
  const [selectedTab, setSelectedTab] = useState<"apps" | "glasses" | "support">("apps")
  const [isScrolled, setIsScrolled] = useState(false)
  const [windowWidth, setWindowWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1920)

  // Track window width for responsive behavior
  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth)
      setIsMobile(window.innerWidth <= 639)
    }

    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [])

  // Get user avatar - try multiple fields
  const getUserAvatar = () => {
    if (!user) return null
    return user.avatarUrl || null
  }

  // Debug: log user data
  useEffect(() => {
    if (user) {
      console.log("User data:", user)
      console.log("Avatar URL:", getUserAvatar())
    }
  }, [user])

  // Handle scroll detection
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 0)
    }

    window.addEventListener("scroll", handleScroll)
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  // Close search mode when clicking outside the header
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement

      // Don't close if clicking on an app card or any clickable app element
      if (
        target.closest("[data-app-card]") ||
        target.closest(".cursor-pointer") ||
        target.closest("a") ||
        target.closest("button")
      ) {
        return
      }

      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setsearchMode(false)
        setSearchQuery("") // Clear search query when closing
        if (onSearchClear) {
          onSearchClear() // Call the clear handler to reset results
        }
      }
    }

    // Only add the event listener if search mode is active
    if (searchMode) {
      document.addEventListener("mousedown", handleClickOutside)
    }

    // Cleanup the event listener
    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
    }
  }, [searchMode, onSearchClear, setSearchQuery])

  // Don't show header in webview
  if (isWebView) {
    return null
  }

  return (
    <header
      className="sticky top-0 z-[5] transition-all duration-300"
      style={{
        background: theme === "light" ? "#ffffff" : "#171717",
        borderBottom: !isMobile && isScrolled ? `1px solid var(--border-color)` : "1px solid transparent",
      }}>
      <div
        className={`mx-auto px-[24px] sm:px-12 md:px-16 lg:px-24 z-20  ${isMobile ? (isAppDetailPage ? "pt-[32px] pb-[32px]" : "pt-[32px]") : "pb-[16px] pt-[16px]"}`}>
        {/* Two-row layout for medium screens, single row for large+ */}
        <div className="flex relative flex-row lg:flex-row lg:items-center lg:justify-between items-center ">
          {/* Top row: Logo and Buttons */}
          <>
            <div className="flex flex-row relative lg:flex-row lg:items-center lg:justify-between gap-4 ">
              {/* Logo and Site Name - hide when search mode is active on small/medium screens */}
              {/* Logo - hide when search mode is active ONLY between 640px-1630px */}
              <AnimatePresence>
                {(!searchMode || windowWidth < 640 || windowWidth > 1330) && (
                  <motion.div
                    initial={{opacity: 1}}
                    exit={{opacity: 0, x: -20}}
                    transition={{duration: 0.2, ease: "easeOut"}}
                    className="flex items-center">
                    <Link
                      to="/"
                      className="flex items-center gap-2 sm:gap-4 select-none hover:opacity-80 transition-opacity">
                      <img
                        src="/mentra_logo_gr.png"
                        alt="Mentra Logo"
                        className="h-[16px] sm:h-7 w-auto object-contain"
                      />
                      <span
                        className="text-[20px] sm:text-[20px] font-normal  mb-[-0px]"
                        style={{
                          fontFamily: "Red Hat Display, sans-serif",
                          letterSpacing: "0.06em",
                          color: "var(--text-primary)",
                          fontWeight: "400",
                        }}>
                        Mentra Store
                      </span>
                    </Link>

                    {/* Navigation tabs - show on large screens (1024px+) right after logo */}
                    {!searchMode && windowWidth >= 1024 && (
                      <div className="flex items-center ml-[73px]">
                        <button
                          className={`font-redhat pb-1 transition-all hover:text-[#00A814] cursor-pointer text-[20px] ${
                            selectedTab === "apps" ? "border-b-2" : ""
                          }`}
                          style={
                            selectedTab === "apps"
                              ? {borderColor: "#00A814", color: "#00A814"}
                              : {color: "var(--text-primary)"}
                          }
                          onClick={() => setSelectedTab("apps")}>
                          Apps
                        </button>

                        <button
                          className="ml-[73px] font-redhat pb-1 transition-all hover:text-[#00A814] cursor-pointer text-[20px]"
                          style={{color: "var(--text-primary)"}}
                          onClick={() => window.open("https://mentraglass.com/", "_blank")}>
                          Glasses
                        </button>

                        <button
                          className="ml-[73px] font-redhat pb-1 transition-all hover:text-[#00A814] cursor-pointer text-[20px]"
                          style={{color: "var(--text-primary)"}}
                          onClick={() => window.open("https://mentraglass.com/contact", "_blank")}>
                          Support
                        </button>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Buttons container - only visible on mobile (below sm) in top row */}
            <div className="flex items-center gap-3 sm:hidden ml-auto justify-end flex-shrink-0 relative">
              {/* Authentication */}
              {isAuthenticated ? (
                <button
                  onClick={profileDropdown.toggleDropdown}
                  className="flex justify-center items-center rounded-full w-[44px] h-[44px] overflow-hidden"
                  style={{
                    backgroundColor: "var(--bg-secondary)",
                  }}>
                  {getUserAvatar() ? (
                    <img
                      key={getUserAvatar()}
                      src={getUserAvatar()!}
                      alt="Profile"
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        console.error("Failed to load avatar:", getUserAvatar())
                        e.currentTarget.style.display = "none"
                      }}
                    />
                  ) : (
                    <User
                      size={20}
                      style={{
                        color: "var(--text-muted)",
                      }}
                    />
                  )}
                </button>
              ) : (
                <Button
                  onClick={() => navigate("/login")}
                  variant={theme === "light" ? "default" : "outline"}
                  className="rounded-full border-[1.0px] border-[var(--border-btn)] flex items-center gap-[10px] py-2 px-4 bg-[var(--primary-foreground)] text-[var(--foreground)]">
                  <User className="w-4 h-4" style={{color: "var(--foreground)"}} />
                  Login
                </Button>
              )}
            </div>

            {/* Search bar - inline between logo and buttons when search mode is active */}
            <AnimatePresence>
              {searchMode && (
                <motion.div
                  initial={{opacity: 0, scale: 0.95}}
                  animate={{opacity: 1, scale: 1}}
                  exit={{opacity: 0, scale: 0.95}}
                  transition={{duration: 0.2, ease: "easeOut"}}
                  className="flex-1 flex justify-center">
                  <div className="w-full max-w-3xl">
                    <SearchBar
                      ref={searchRef}
                      searchQuery={searchQuery}
                      onSearchChange={onSearchChange || setSearchQuery}
                      onSearchSubmit={onSearch || ((e) => e.preventDefault())}
                      onClear={onSearchClear || (() => setSearchQuery(""))}
                      autoFocus={true}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Buttons for small screens and above - hide when search mode is active ONLY between 640px-1630px */}
            <AnimatePresence>
              {(!searchMode || windowWidth < 640 || windowWidth > 1330) && (
                <motion.div
                  initial={{opacity: 1}}
                  exit={{opacity: 0, x: 20}}
                  transition={{duration: 0.2, ease: "easeOut"}}
                  className="hidden sm:flex items-center gap-4 ml-auto  justify-end">
                  {/* Get MentraOS Button */}
                  {/* <GetMentraOSButton size="small" /> */}

                  {/* Authentication */}
                  {isAuthenticated ? (
                    <div className="flex gap-[10px] justify-center items-center">
                      {/* <Button
                  onClick={handleSignOut}
                  variant={theme === 'light' ? 'default' : 'outline'}
                  className="rounded-full border-[1.5px]"
                  style={{
                    backgroundColor: theme === 'light' ? '#000000' : 'transparent',
                    borderColor: theme === 'light' ? '#000000' : '#C0C4FF',
                    color: theme === 'light' ? '#ffffff' : '#C0C4FF'
                  }}
                >
                  Sign Out
                </Button> */}

                      <button
                        className="flex justify-center items-center rounded-full w-[36px] h-[36px] cursor-pointer transition-colors"
                        style={{
                          backgroundColor: "transparent",
                        }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.backgroundColor = theme === "light" ? "#F2F2F2" : "#27272a")
                        }
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                        onClick={() => {
                          // If not on store page, redirect to it with search param
                          if (!isStorePage) {
                            navigate("/?search=true")
                          } else {
                            setsearchMode(true)
                          }
                        }}>
                        <Search
                          size={"20px"}
                          style={{
                            color: "var(--text-muted)",
                          }}
                        />
                      </button>
                      <DropDown
                        trigger={
                          <button
                            className="flex justify-center items-center rounded-full w-[44px] h-[44px] overflow-hidden"
                            style={{
                              backgroundColor: "var(--bg-secondary)",
                            }}>
                            {getUserAvatar() ? (
                              <img
                                key={getUserAvatar()}
                                src={getUserAvatar()!}
                                alt="Profile"
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  console.error("Failed to load avatar:", getUserAvatar())
                                  e.currentTarget.style.display = "none"
                                }}
                              />
                            ) : (
                              <User
                                size={20}
                                style={{
                                  color: "var(--text-muted)",
                                }}
                              />
                            )}
                          </button>
                        }
                        contentClassName="mt-2 right-0 shadow-lg rounded-xl p-0 min-w-[280px]">
                        <ProfileDropdown variant="desktop" />
                      </DropDown>
                    </div>
                  ) : (
                    <div className="flex gap-[10px]">
                      <button
                        className="flex justify-center items-center rounded-full w-[36px] h-[36px] cursor-pointer transition-colors"
                        style={{
                          backgroundColor: "transparent",
                        }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.backgroundColor = theme === "light" ? "#F2F2F2" : "#27272a")
                        }
                        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                        onClick={() => {
                          // If not on store page, redirect to it with search param
                          if (!isStorePage) {
                            navigate("/?search=true")
                          } else {
                            setsearchMode(true)
                          }
                        }}>
                        <Search
                          size={"20px"}
                          style={{
                            color: "var(--text-muted)",
                          }}
                        />
                      </button>
                      <Button
                        onClick={() => navigate("/login")}
                        variant={theme === "light" ? "default" : "outline"}
                        className="rounded-full border-[1.0px] border-[var(--border-btn)] flex items-center gap-[10px] py-2 px-4 bg-[var(--primary-foreground)] text-[var(--foreground)]">
                        <User className="w-4 h-4" style={{color: "var(--foreground)"}} />
                        Login
                      </Button>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </>
        </div>
      </div>
    </header>
  )
}

export default Header
