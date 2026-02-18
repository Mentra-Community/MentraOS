import {useEffect, useState, useRef} from "react"
import {View, Modal, ActivityIndicator} from "react-native"
import {Text, Button} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useGlassesStore} from "@/stores/glasses"
import {translate} from "@/i18n"

const CANCEL_BUTTON_DELAY_MS = 10000 // 10 seconds before enabling cancel button

interface ConnectionOverlayProps {
  /** Custom title to display instead of default "Glasses are reconnecting" */
  customTitle?: string
  /** Custom message to display instead of default reconnecting message. Set to empty string to hide. */
  customMessage?: string
  /** Hide the "Stop trying" button entirely */
  hideStopButton?: boolean
  /** Use smaller title text */
  smallTitle?: boolean
}

export function ConnectionOverlay({
  customTitle,
  customMessage,
  hideStopButton,
  smallTitle,
}: ConnectionOverlayProps = {}) {
  const {theme} = useAppTheme()
  const {clearHistoryAndGoHome} = useNavigationHistory()
  const glassesConnected = useGlassesStore((state) => state.connected)
  const [showOverlay, setShowOverlay] = useState(false)
  const [cancelButtonEnabled, setCancelButtonEnabled] = useState(false)
  const cancelButtonTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!glassesConnected) {
      setShowOverlay(true)
      setCancelButtonEnabled(false)
      // Start timer to enable cancel button after delay
      cancelButtonTimerRef.current = setTimeout(() => {
        setCancelButtonEnabled(true)
      }, CANCEL_BUTTON_DELAY_MS)
    } else {
      setShowOverlay(false)
      setCancelButtonEnabled(false)
      // Clear timer if connection succeeds
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
  }, [glassesConnected])

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
          {customMessage !== undefined ? (
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
