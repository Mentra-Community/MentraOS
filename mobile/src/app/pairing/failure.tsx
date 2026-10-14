import {engine} from "@mentra/engine"
import {useLocalSearchParams} from "expo-router"
import {useEffect} from "react"
import {View} from "react-native"
import Animated, {useAnimatedStyle, useSharedValue, withTiming} from "react-native-reanimated"

import {Screen, Header, Text, Button, Icon} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {TxKeyPath} from "@/i18n"
import {translate} from "@/i18n/translate"
import {IOS_FORGET_GLASSES_BLUETOOTH_ERROR} from "@/utils/pairing/iosStaleBond"
import {SettingsNavigationUtils} from "@/utils/SettingsNavigationUtils"

export default function PairingFailureScreen() {
  const {theme} = useAppTheme()
  const {clearHistoryAndGoHome, push} = useNavigationStore.getState()

  const {error, deviceModel}: {error: string; deviceModel?: string} = useLocalSearchParams()

  const fadeInOpacity = useSharedValue(0)
  const slideUpTranslate = useSharedValue(50)

  const animatedContainerStyle = useAnimatedStyle(() => ({
    opacity: fadeInOpacity.value,
    transform: [{translateY: slideUpTranslate.value}],
  }))

  useEffect(() => {
    fadeInOpacity.value = withTiming(1, {duration: 800})
    slideUpTranslate.value = withTiming(0, {duration: 800})
  }, [])

  const handleRetry = () => {
    // Clears the failed attempt; a pre-existing pairing (re-pair) is preserved.
    void engine.pairing.abandonAttempt().catch((error) => {
      console.warn("Pairing retry cleanup failed:", error)
    })
    clearHistoryAndGoHome()
    push("/pairing/select-glasses-model")
  }

  const handleGoHome = () => {
    clearHistoryAndGoHome()
  }

  const needsBluetoothForget = error === IOS_FORGET_GLASSES_BLUETOOTH_ERROR

  const handleOpenSettings = async () => {
    const success = await SettingsNavigationUtils.openBluetoothSettings()
    if (!success) {
      console.error("Failed to open Bluetooth settings")
    }
  }

  return (
    <Screen preset="fixed" className="" safeAreaEdges={["top", "bottom"]}>
      <Header />

      <Animated.View style={animatedContainerStyle} className="flex-1 items-center justify-center px-4">
        <View
          className="p-6 rounded-[130px] mb-8 w-[130px] h-[130px] items-center justify-center"
          style={{backgroundColor: theme.colors.errorBackground || theme.colors.palette.angry100}}>
          <Icon name="exclamation-circle" size={80} color={theme.colors.chart_5} />
        </View>

        <Text
          tx="pairing:pairingFailed"
          preset="heading"
          className="text-[28px] font-bold mb-4 text-center text-text"
        />

        <Text
          text={translate(error as TxKeyPath, {glassesModel: deviceModel || "glasses"})}
          preset="default"
          className="text-[16px] text-center mb-12 leading-6 px-4 text-text-dim"
        />

        <View className="w-full gap-3 flex-grow items-end justify-end">
          {needsBluetoothForget ? (
            <Button tx="pairing:openSettings" preset="primary" onPress={handleOpenSettings} className="w-full" />
          ) : null}

          <Button
            tx="common:tryAgain"
            preset={needsBluetoothForget ? "alternate" : "primary"}
            onPress={handleRetry}
            className="w-full"
          />

          <Button tx="pairing:goHome" preset="alternate" onPress={handleGoHome} className="w-full" />
        </View>

        {/* <View className="flex-row items-center mt-8">
          <Icon name="info-circle" size={16} color={theme.colors.textDim} />
          <Text
            text="Make sure your glasses are powered on and in pairing mode"
            preset="formHelper"
            className="ml-2 text-xs text-text-dim"
          />
        </View> */}
      </Animated.View>
    </Screen>
  )
}
