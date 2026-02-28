import {useEffect, useState, useRef, createContext} from "react"
import {View, Modal, ActivityIndicator} from "react-native"
import {usePathname} from "expo-router"
import {Text, Button} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useGlassesStore} from "@/stores/glasses"
import {translate} from "@/i18n"
import {create} from "zustand"

const CANCEL_BUTTON_DELAY_MS = 10000 // 10 seconds before enabling cancel button

// Routes that should show the connection overlay when glasses disconnect
const OVERLAY_ROUTES = [
  "/wifi/password",
  "/wifi/connecting",
  "/wifi/scan",
  "/ota/progress",
  "/ota/check-for-updates",
  "/onboarding/live",
]

// Store for custom overlay configuration (used by OTA progress screen)
interface OverlayConfigState {
  customTitle: string | null
  customMessage: string | null
  hideStopButton: boolean
  smallTitle: boolean
  setConfig: (config: {
    customTitle?: string | null
    customMessage?: string | null
    hideStopButton?: boolean
    smallTitle?: boolean
  }) => void
  clearConfig: () => void
}

export const useConnectionOverlayConfig = create<OverlayConfigState>((set) => ({
  customTitle: null,
  customMessage: null,
  hideStopButton: false,
  smallTitle: false,
  setConfig: (config) =>
    set((state) => ({
      customTitle: config.customTitle !== undefined ? config.customTitle : state.customTitle,
      customMessage: config.customMessage !== undefined ? config.customMessage : state.customMessage,
      hideStopButton: config.hideStopButton !== undefined ? config.hideStopButton : state.hideStopButton,
      smallTitle: config.smallTitle !== undefined ? config.smallTitle : state.smallTitle,
    })),
  clearConfig: () => set({customTitle: null, customMessage: null, hideStopButton: false, smallTitle: false}),
}))

function GlobalConnectionOverlay() {
  const {theme} = useAppTheme()
  const {clearHistoryAndGoHome} = useNavigationHistory()
  const pathname = usePathname()
  const glassesConnected = useGlassesStore((state) => state.connected)
  const {customTitle, customMessage, hideStopButton, smallTitle} = useConnectionOverlayConfig()

  const [showOverlay, setShowOverlay] = useState(false)
  const [cancelButtonEnabled, setCancelButtonEnabled] = useState(false)
  const cancelButtonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Check if current route should show overlay
  const shouldShowOnRoute = OVERLAY_ROUTES.some((route) => pathname.startsWith(route))

  useEffect(() => {
    if (!glassesConnected && shouldShowOnRoute) {
      setShowOverlay(true)
      setCancelButtonEnabled(false)
      // Start timer to enable cancel button after delay
      cancelButtonTimerRef.current = setTimeout(() => {
        setCancelButtonEnabled(true)
      }, CANCEL_BUTTON_DELAY_MS)
    } else {
      setShowOverlay(false)
      setCancelButtonEnabled(false)
      // Clear timer if connection succeeds or we navigate away
      if (cancelButtonTimerRef.current) {
        clearTimeout(cancelButtonTimerRef.current)
        cancelButtonTimerRef.current = null
      }
    }

    return () => {
      if (cancelButtonTimerRef.current) {
        clearTimeout(cancelButtonTimerRef.current)
        cancelButtonTimerRef.current = null
      }
    }
  }, [glassesConnected, shouldShowOnRoute])

  const handleStopTrying = () => {
    if (!cancelButtonEnabled) return
    setShowOverlay(false)
    setCancelButtonEnabled(false)
    clearHistoryAndGoHome()
  }

  if (!showOverlay) return null

  return (
    <Modal transparent animationType="fade" visible={showOverlay}>
      <View className="flex-1 justify-center items-center" style={{backgroundColor: "rgba(0, 0, 0, 0.7)"}}>
        <View className="rounded-2xl p-8 mx-6 items-center" style={{backgroundColor: theme.colors.background}}>
          <ActivityIndicator size="large" color={theme.colors.foreground} />
          {customTitle ? (
            <Text
              className={`${smallTitle ? "text-base" : "text-xl"} font-semibold text-text text-center mt-6 mb-2`}
              text={customTitle}
            />
          ) : (
            <Text
              className="text-xl font-semibold text-text text-center mt-6 mb-2"
              tx="glasses:glassesAreReconnecting"
            />
          )}
          {customMessage !== undefined && customMessage !== null ? (
            customMessage ? (
              <Text className="text-base text-text-dim text-center mb-6" text={customMessage} />
            ) : null
          ) : (
            <Text className="text-base text-text-dim text-center mb-6" tx="glasses:glassesAreReconnectingMessage" />
          )}
          {!hideStopButton && (
            <Button
              text={translate("home:stopTrying")}
              preset="secondary"
              onPress={handleStopTrying}
              disabled={!cancelButtonEnabled}
              style={{opacity: cancelButtonEnabled ? 1 : 0.4}}
            />
          )}
        </View>
      </View>
    </Modal>
  )
}

type ConnectionOverlayContextType = {}

const ConnectionOverlayContext = createContext<ConnectionOverlayContextType | null>(null)
export default function ConnectionOverlayProvider({children}: {children: React.ReactNode}) {
  return (
    <ConnectionOverlayContext.Provider value={{}}>
      {children}
      <GlobalConnectionOverlay />
    </ConnectionOverlayContext.Provider>
  )
}
