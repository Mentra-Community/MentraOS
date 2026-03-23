import {useState, useEffect, useCallback, createContext, useContext} from "react"
import {useMentraAuth} from "@mentra/react"
import HomePage from "./pages/home/HomePage"

// Theme Context
interface ThemeContextValue {
  theme: "light" | "dark"
  isDarkMode: boolean
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  isDarkMode: false,
  toggleTheme: () => {},
})

export function useTheme() {
  return useContext(ThemeContext)
}

export default function App() {
  const {userId, isLoading, error, isAuthenticated} = useMentraAuth()

  // Theme state with localStorage persistence
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("theme")
      if (saved === "dark" || saved === "light") return saved
    }
    return "light"
  })

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light"
      localStorage.setItem("theme", next)
      return next
    })
  }, [])

  // Apply dark class to document root
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark")
  }, [theme])

  // Sync theme with backend when user authenticates
  useEffect(() => {
    if (isAuthenticated && userId) {
      fetch(`/api/storage/theme?userId=${encodeURIComponent(userId)}`)
        .then((res) => res.json())
        .then((data) => {
          if (data.theme === "dark" || data.theme === "light") {
            setTheme(data.theme)
            localStorage.setItem("theme", data.theme)
          }
        })
        .catch(() => {})
    }
  }, [isAuthenticated, userId])

  // Save theme to backend on change
  useEffect(() => {
    if (isAuthenticated && userId) {
      fetch("/api/storage/theme", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({userId, theme}),
      }).catch(() => {})
    }
  }, [theme, isAuthenticated, userId])

  // Keyboard shortcut: Cmd+Shift+D to toggle theme
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "d" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        e.preventDefault()
        toggleTheme()
      }
    }
    document.addEventListener("keydown", down)
    return () => document.removeEventListener("keydown", down)
  }, [toggleTheme])

  // Loading state
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-muted border-t-foreground" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center p-8 max-w-md">
          <h2 className="text-destructive text-lg font-semibold mb-2">Authentication Error</h2>
          <p className="text-destructive/80 text-sm mb-4">{error}</p>
          <p className="text-muted-foreground text-xs">
            Please ensure you are opening this page from the MentraOS app.
          </p>
        </div>
      </div>
    )
  }

  return (
    <ThemeContext.Provider value={{theme, isDarkMode: theme === "dark", toggleTheme}}>
      <div className="font-sans bg-background text-foreground min-h-screen">
        <HomePage userId={userId || ""} />
      </div>
    </ThemeContext.Provider>
  )
}
