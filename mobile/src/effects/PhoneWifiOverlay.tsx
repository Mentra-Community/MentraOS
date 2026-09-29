import {useEffect, useRef, useSyncExternalStore} from "react"
import {Animated, BackHandler, View} from "react-native"

import {Button, Icon, Text} from "@/components/ignite"
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
  useEffect(registerPhoneWifiPromptHost, [])
  useEffect(() => {
    if (!request) return
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
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
  if (!request) return null
  return (
    <View
      className="absolute inset-0 items-center justify-center px-6"
      style={{zIndex: 10000, backgroundColor: theme.colors.modalOverlay}}
      accessibilityViewIsModal>
      <Animated.View className="w-full max-w-[400px] items-center" style={{opacity: fade, transform: [{scale}]}}>
        <View className="w-full rounded-[25px] bg-primary-foreground p-6">
          <View className="mb-4 flex-row items-center gap-3">
            <View className="h-11 w-11 items-center justify-center rounded-2xl bg-primary/10">
              <Icon name={request.tone === "still-off" ? "wifi-off" : "wifi"} size={25} color={theme.colors.primary} />
            </View>
            <Text text={request.title} weight="semibold" className="flex-1 text-[22px] leading-7" />
          </View>
          <Text text={request.message} className="mb-6 text-[15px] leading-6 text-muted-foreground" />
          <View className="flex-row gap-3">
            <Button
              preset="alternate"
              text={translate("common:cancel")}
              style={{flex: 1, minHeight: 48, paddingVertical: 12, paddingHorizontal: 8, borderRadius: 28}}
              textStyle={{fontSize: 14}}
              onPress={() => completePhoneWifiPrompt(false, request.id)}
            />
            <Button
              preset="primary"
              text={request.actionLabel}
              style={{flex: 1.6, minHeight: 48, paddingVertical: 12, paddingHorizontal: 8, borderRadius: 28}}
              textStyle={{fontSize: 14}}
              onPress={() => completePhoneWifiPrompt(true, request.id)}
            />
          </View>
        </View>
      </Animated.View>
    </View>
  )
}
