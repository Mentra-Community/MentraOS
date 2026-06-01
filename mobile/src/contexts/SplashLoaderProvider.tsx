import {FC, ReactNode, createContext, useCallback, useContext, useEffect, useState} from "react"
import Animated, {useAnimatedStyle, useSharedValue, withTiming} from "react-native-reanimated"
import {scheduleOnRN} from "react-native-worklets"

import {Screen} from "@/components/ignite"
import {SplashVideo} from "@/components/splash/SplashVideo"
import {useAppTheme} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting} from "@/stores/settings"

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
  const {theme} = useAppTheme()
  const [superMode] = useSetting(SETTINGS.super_mode.key)
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
            <SplashVideo colorOverride={superMode ? theme.colors.chart_5 : undefined} />
          </Screen>
        </Animated.View>
      )}
    </SplashLoaderContext.Provider>
  )
}
