import {useEffect, useRef, useSyncExternalStore} from "react"
import {Animated, BackHandler, View} from "react-native"

import {Icon} from "@/components/ignite"
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
  const fade = useRef(new Animated.Value(0)).current
  const scale = useRef(new Animated.Value(0.93)).current
  const iconScale = useRef(new Animated.Value(0.6)).current
  useEffect(registerPhoneWifiPromptHost, [])
  useEffect(() => {
    if (!request) return
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      if (request.tone === "on") return true
      completePhoneWifiPrompt(false, request.id)
      return true
    })
    return () => back.remove()
  }, [request])
  useEffect(() => {
    if (!request) return
    fade.setValue(0)
    scale.setValue(0.93)
    Animated.parallel([
      Animated.timing(fade, {toValue: 1, duration: 200, useNativeDriver: true}),
      Animated.spring(scale, {toValue: 1, friction: 8, tension: 100, useNativeDriver: true}),
    ]).start()
  }, [fade, request, scale])
  useEffect(() => {
    if (request?.tone !== "on") return
    iconScale.setValue(0.6)
    Animated.spring(iconScale, {toValue: 1, friction: 5, tension: 120, useNativeDriver: true}).start()
  }, [iconScale, request?.tone])
  if (!request) return null
  const wifiOn = request.tone === "on"
  return (
    <View
      className="absolute inset-0 items-center justify-center px-6"
      style={{zIndex: 10000, backgroundColor: theme.colors.modalOverlay}}
      accessibilityViewIsModal>
      <Animated.View style={{opacity: fade, transform: [{scale}]}}>
        {wifiOn ? (
          <View
            className="items-center gap-3 rounded-2xl px-8 py-7"
            style={{backgroundColor: theme.colors.primary_foreground}}>
            <Animated.View style={{transform: [{scale: iconScale}]}}>
              <Icon name="wifi" size={36} color={theme.colors.palette.mediumBlue} />
            </Animated.View>
            <Animated.Text style={{color: theme.colors.text, fontSize: 18, fontWeight: "600"}}>
              {request.title}
            </Animated.Text>
          </View>
        ) : (
          <BasicDialog
            title={request.title}
            description={request.message}
            icon={
              request.tone === "still-off" ? (
                <Icon name="wifi-off" size={28} color={theme.colors.textDim} />
              ) : (
                <Icon name="wifi" size={28} color={theme.colors.palette.mediumBlue} />
              )
            }
            leftButtonText={translate("common:cancel")}
            rightButtonText={request.actionLabel}
            onLeftPress={() => completePhoneWifiPrompt(false, request.id)}
            onRightPress={() => completePhoneWifiPrompt(true, request.id)}
          />
        )}
      </Animated.View>
    </View>
  )
}
