import {FC, ReactNode, createContext, useCallback, useContext, useEffect, useState} from "react"
import Animated, {useAnimatedStyle, useSharedValue, withTiming} from "react-native-reanimated"
import {scheduleOnRN} from "react-native-worklets"

import {Screen} from "@/components/ignite"
import {SplashVideo} from "@/components/splash/SplashVideo"
import {SETTINGS, useSetting} from "@mentra/engine"

interface SplashLoaderContextType {
  splashEnabled: boolean
  setSplashEnabled: (v: boolean) => void
}

const SplashLoaderContext = createContext<SplashLoaderContextType | null>(null)

export const useSplashLoader = (): SplashLoaderContextType => {
  const ctx = useContext(SplashLoaderContext)
  if (!ctx) {
    throw new Error("useSplashLoader must be used within a SplashLoaderProvider")
  }
  return ctx
}

const FADE_MS = 250

export const SplashLoaderProvider: FC<{children: ReactNode}> = ({children}) => {
  const [appBootExtraInfo] = useSetting(SETTINGS.app_boot_extra_info.key)
  const [splashEnabled, setSplashEnabledState] = useState(false)
  const [visible, setVisible] = useState(false)
  const opacity = useSharedValue(0)

  const setSplashEnabled = useCallback((v: boolean) => {
    setSplashEnabledState(v)
  }, [])

  useEffect(() => {
    if (splashEnabled) {
      setVisible(true)
      opacity.value = withTiming(1, {duration: FADE_MS})
      return
    }
    opacity.value = withTiming(0, {duration: FADE_MS}, (finished) => {
      if (finished) {
        scheduleOnRN(setVisible, false)
      }
    })
  }, [splashEnabled, opacity])

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }))

  return (
    <SplashLoaderContext.Provider value={{splashEnabled, setSplashEnabled}}>
      {children}
      {visible && (
        <Animated.View className="absolute inset-0 z-50" style={overlayStyle}>
          <Screen preset="fixed">
            <SplashVideo label={appBootExtraInfo ? "Opening link…" : undefined} />
          </Screen>
        </Animated.View>
      )}
    </SplashLoaderContext.Provider>
  )
}
