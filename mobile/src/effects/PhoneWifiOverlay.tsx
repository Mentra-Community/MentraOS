import {useEffect, useSyncExternalStore} from "react"
import {BackHandler, View} from "react-native"

import BasicDialog from "@/components/ui/BasicDialog"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {
  completePhoneWifiPrompt,
  getPhoneWifiPrompt,
  registerPhoneWifiPromptHost,
  subscribePhoneWifiPrompt,
} from "@/services/phoneWifiPrompt"

/** Retains its own prompt when another host alert appears; never closes the miniapp. */
export function PhoneWifiOverlay() {
  const request = useSyncExternalStore(subscribePhoneWifiPrompt, getPhoneWifiPrompt, getPhoneWifiPrompt)
  const {theme} = useAppTheme()
  useEffect(registerPhoneWifiPromptHost, [])
  useEffect(() => {
    if (!request) return
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      completePhoneWifiPrompt(false, request.id)
      return true
    })
    return () => back.remove()
  }, [request])
  if (!request) return null
  return (
    <View
      className="absolute inset-0 items-center justify-center px-6"
      style={{zIndex: 10000, backgroundColor: theme.colors.modalOverlay}}
      accessibilityViewIsModal>
      <BasicDialog
        title={request.title}
        description={request.message}
        leftButtonText={translate("common:cancel")}
        rightButtonText={request.actionLabel}
        onLeftPress={() => completePhoneWifiPrompt(false, request.id)}
        onRightPress={() => completePhoneWifiPrompt(true, request.id)}
      />
    </View>
  )
}
