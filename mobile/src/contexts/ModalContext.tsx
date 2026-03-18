import * as NavigationBar from "expo-navigation-bar"
import {GlassView} from "expo-glass-effect"
import {useState, useEffect, useRef, useCallback} from "react"
import {BackHandler, Platform, StyleSheet, TouchableOpacity, View} from "react-native"
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedProps,
  withTiming,
  withSpring,
} from "react-native-reanimated"

import {Button, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n/translate"
import {scheduleOnRN} from "react-native-worklets"

const AnimatedGlassView = Animated.createAnimatedComponent(GlassView)

// Types
export type ButtonStyle = "default" | "cancel" | "destructive"

export interface AlertButton {
  text: string
  style?: ButtonStyle
}

export interface AlertOptions {
  icon?: React.ReactNode
  content?: React.ReactNode
  allowDismiss?: boolean
}

interface AlertState {
  title: string
  message?: string
  buttons: AlertButton[]
  options: AlertOptions
  resolve: (value: number) => void
}

// Global ref
let showModalFn: ((state: Omit<AlertState, "resolve">) => Promise<number>) | null = null

export const setModalRef = (fn: typeof showModalFn) => {
  showModalFn = fn
}

// Provider
export function ModalProvider({children}: {children: React.ReactNode}) {
  const {theme} = useAppTheme()
  const [state, setState] = useState<AlertState | null>(null)
  const resolveRef = useRef<((value: number) => void) | null>(null)

  const fadeAnim = useSharedValue(0)
  const scaleAnim = useSharedValue(0.93)

  const animateIn = useCallback(() => {
    fadeAnim.value = withTiming(1, {duration: 200})
    scaleAnim.value = withSpring(1, {damping: 200, stiffness: 800})
  }, [fadeAnim, scaleAnim])

  const animateOut = useCallback(
    (onDone?: () => void) => {
      fadeAnim.value = withTiming(0, {duration: 150})
      scaleAnim.value = withTiming(0.93, {duration: 150}, (finished) => {
        if (finished && onDone) {
          scheduleOnRN(onDone)
        }
      })
    },
    [fadeAnim, scaleAnim],
  )

  const dismiss = useCallback(
    (buttonIndex: number) => {
      animateOut(() => {
        resolveRef.current?.(buttonIndex)
        resolveRef.current = null
        setState(null)
      })
    },
    [animateOut],
  )

  // Hardware back press
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (state) return true
      return false
    })
    return () => sub.remove()
  }, [state])

  // Nav bar color on Android
  //   useEffect(() => {
  //     if (Platform.OS !== "android") return
  //     if (state) {
  //       NavigationBar.setBackgroundColorAsync(theme.isDark ? "#000000" : "#1a1a1a").catch(() => {})
  //       NavigationBar.setButtonStyleAsync("light").catch(() => {})
  //     } else {
  //       NavigationBar.setButtonStyleAsync(theme.isDark ? "light" : "dark").catch(() => {})
  //     }
  //   }, [state, theme])

  // Animate in when state appears
  useEffect(() => {
    if (state) animateIn()
  }, [state, animateIn])

  // Register global fn
  useEffect(() => {
    setModalRef(
      (alertState) =>
        new Promise<number>((resolve) => {
          resolveRef.current = resolve
          setState({...alertState, resolve})
        }),
    )
    return () => setModalRef(null)
  }, [])

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: fadeAnim.value,
  }))

  const wrapperStyle = useAnimatedStyle(() => ({
    width: "100%",
    maxWidth: 400,
    transform: [{scale: scaleAnim.value}],
    opacity: fadeAnim.value,
  }))

  // const glassProps = useAnimatedProps(() => ({
  //   glassEffectStyle: {
  //     style: fadeAnim.value > 0.01 ? "regular" : "none",
  //     animate: true,
  //     animationDuration: 0.2,
  //   } as any,
  // }))

  return (
    <>
      {children}
      {state && (
        <Animated.View
          style={[StyleSheet.absoluteFillObject, backdropStyle]}
          className="z-50 justify-center items-center px-6">
          <TouchableOpacity
            className="absolute inset-0 bg-black/75"
            activeOpacity={1}
            onPress={() => {
              const cancelIndex = state.buttons.findIndex((b) => b.style === "cancel")
              if (cancelIndex !== -1 && state.options.allowDismiss) {
                dismiss(cancelIndex)
              }
            }}
          />

          <Animated.View style={wrapperStyle}>
            <Animated.View className="rounded-2xl overflow-hidden bg-primary-foreground">
              {/* Icon */}
              {state.options.icon && <View className="items-center pt-6 pb-2">{state.options.icon}</View>}

              {/* Title + Message */}
              <View className="px-6 pt-6 gap-4 self-stretch">
                <Text style={{color: theme.colors.secondary_foreground, fontSize: 20, alignSelf: "stretch", textAlign: "left"}} weight="semibold">{state.title}</Text>
                {state.message && <Text style={{color: theme.colors.secondary_foreground, fontSize: 14, fontWeight: "500", alignSelf: "stretch", textAlign: "left"}}>{state.message}</Text>}
              </View>

              {/* Custom content */}
              {state.options.content && <View className="px-6 pb-4">{state.options.content}</View>}

              <View className="h-px mx-6 mt-4" style={{backgroundColor: theme.colors.border}} />

              <View className="flex-row gap-4 pl-2 pr-6 py-5 justify-end">
                {state.buttons.map((button, index) => {
                  const isCancel = button.style === "cancel"

                  return (
                    <Button
                      key={button.text}
                      style={{minWidth: 96}}
                      compact
                      flexContainer={false}
                      onPress={() => dismiss(index)}
                      flex={false}
                      preset={isCancel ? "alternate" : "primary"}
                      text={button.text}
                    />
                  )
                })}
              </View>
            </Animated.View>
          </Animated.View>
        </Animated.View>
      )}
    </>
  )
}

// Core function
interface ShowAlertProps {
  title: string
  message?: string
  buttons?: AlertButton[]
  options?: AlertOptions
}

export const showAlert = ({title, message, buttons, options}: ShowAlertProps): Promise<number> => {
  if (!buttons) {
    buttons = [{text: translate("common:ok")}]
  }
  if (!options) {
    options = {allowDismiss: true}
  }

  if (!showModalFn) {
    return Promise.resolve(-1)
  }

  return showModalFn({title, message, buttons, options})
}

export default showAlert
