import {Calendar, Camera, MapPin, Mic, Shield, Cpu, Speaker, Wifi, RotateCw, CircleDot, Lightbulb} from "lucide-react"
import {HardwareType, AppI} from "../types"

// App tags mapping
export const APP_TAGS: Record<string, string[]> = {
  "X": ["Social", "News", "Media"],
  "Merge": ["Chat", "Social"],
  "Live Captions": ["Language", "Communication"],
  "Streamer": ["Video", "Broadcast"],
  "Translation": ["Language", "Communication"],
  "LinkLingo": ["Language", "Learning"],
  "Mentra Notes": ["Tools"],
  "Dash": ["Fitness", "Running"],
  "Calendar": ["Time", "Schedule"],
  "Teleprompter": ["Media", "Tools"],
  "MemCards": ["Learning", "Memory"],
}

// Hardware icon mapping
export const hardwareIcons: Record<HardwareType, React.ReactNode> = {
  [HardwareType.CAMERA]: <Camera className="h-6 w-6" />,
  [HardwareType.DISPLAY]: <Cpu className="h-6 w-6" />,
  [HardwareType.MICROPHONE]: <Mic className="h-6 w-6" />,
  [HardwareType.SPEAKER]: <Speaker className="h-6 w-6" />,
  [HardwareType.IMU]: <RotateCw className="h-6 w-6" />,
  [HardwareType.BUTTON]: <CircleDot className="h-6 w-6" />,
  [HardwareType.LIGHT]: <Lightbulb className="h-6 w-6" />,
  [HardwareType.WIFI]: <Wifi className="h-6 w-6" />,
}

// Get icon for permission type
export const getPermissionIcon = (type: string) => {
  const normalizedType = type.toLowerCase()
  if (normalizedType.includes("microphone") || normalizedType.includes("audio")) {
    return <Mic className="h-6 w-6" />
  }
  if (normalizedType.includes("camera") || normalizedType.includes("photo")) {
    return <Camera className="h-6 w-6" />
  }
  if (normalizedType.includes("location") || normalizedType.includes("gps")) {
    return <MapPin className="h-6 w-6" />
  }
  if (normalizedType.includes("calendar")) {
    return <Calendar className="h-6 w-6" />
  }
  return <Shield className="h-6 w-6" />
}

// Get default description for permission type
export const getPermissionDescription = (type: string) => {
  const normalizedType = type.toLowerCase()
  if (normalizedType.includes("microphone") || normalizedType.includes("audio")) {
    return "For voice import and audio processing."
  }
  if (normalizedType.includes("camera") || normalizedType.includes("photo")) {
    return "For capturing photos and recording videos."
  }
  if (normalizedType.includes("location") || normalizedType.includes("gps")) {
    return "For location-based features and services."
  }
  if (normalizedType.includes("calendar")) {
    return "For accessing and managing calendar events."
  }
  return "For app functionality and features."
}

// Formatted date for display
export const formatDate = (dateString?: string) => {
  if (!dateString) return "N/A"
  return new Date(dateString).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  })
}

// Get app type display name
export const getAppTypeDisplay = (app: AppI) => {
  const appType = app.appType ?? app.tpaType ?? "Foreground"
  return appType === "standard" ? "Foreground" : appType
}

// Theme type
export type Theme = "light" | "dark"

// Base shared prop types
export interface AppDetailsBasePropsCore {
  app: AppI
  theme: Theme
  isAuthenticated: boolean
  isWebView: boolean
  installingApp: boolean
  activeTab: "description" | "permissions" | "hardware" | "contact" | ""
  setActiveTab: React.Dispatch<React.SetStateAction<"description" | "permissions" | "hardware" | "contact" | "">>
  handleBackNavigation: () => void
  handleInstall: () => Promise<void>
  navigateToLogin: () => void
}

// Mobile-specific props (includes uninstall handler)
export interface AppDetailsMobileProps extends AppDetailsBasePropsCore {
  handleUninstall: () => Promise<void>
}

// Desktop-specific props (also includes uninstall handler)
export interface AppDetailsDesktopProps extends AppDetailsBasePropsCore {
  handleUninstall: () => Promise<void>
}

// Backward compatibility
export type AppDetailsBaseProps = AppDetailsMobileProps
