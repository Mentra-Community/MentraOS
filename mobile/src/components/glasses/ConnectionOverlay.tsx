import {useEffect, useState} from "react"
import {View, Modal, ActivityIndicator} from "react-native"
import {Text, Button} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useGlassesStore} from "@/stores/glasses"

export function ConnectionOverlay() {
  const {theme} = useAppTheme()
  const {replaceAll} = useNavigationHistory()
  const glassesConnected = useGlassesStore((state) => state.connected)
  const [showOverlay, setShowOverlay] = useState(false)

  useEffect(() => {
    if (!glassesConnected) {
      setShowOverlay(true)
    } else {
      setShowOverlay(false)
    }
  }, [glassesConnected])

  const handleCancel = () => {
    setShowOverlay(false)
    replaceAll("/pairing/select-glasses-model")
  }

  if (!showOverlay) return null

  return (
    <Modal transparent animationType="fade" visible={showOverlay}>
      <View className="flex-1 justify-center items-center" style={{backgroundColor: "rgba(0, 0, 0, 0.7)"}}>
        <View className="rounded-2xl p-8 mx-6 items-center" style={{backgroundColor: theme.colors.background}}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text className="text-xl font-semibold text-text text-center mt-6 mb-2" tx="glasses:glassesAreReconnecting" />
          <Text className="text-base text-text-dim text-center mb-6" tx="glasses:glassesAreReconnectingMessage" />
          <Button tx="common:cancel" preset="secondary" onPress={handleCancel} />
        </View>
      </View>
    </Modal>
  )
}
