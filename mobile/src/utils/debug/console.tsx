import {useState, useEffect, useRef} from "react"
import {ScrollView, View, ViewStyle, TextStyle, NativeScrollEvent, NativeSyntheticEvent} from "react-native"
import {Gesture, GestureDetector} from "react-native-gesture-handler"
import Animated, {useSharedValue, useAnimatedStyle, withSpring} from "react-native-reanimated"

import {Button} from "@/components/ignite"
import {Text} from "@/components/ignite/Text"
import {useAppTheme} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"

const MIN_Y = 60
const MIN_X = 0

export const ConsoleLogger = () => {
  const {themed} = useAppTheme()
  const [logs, setLogs] = useState([])
  const [isVisible, setIsVisible] = useState(false)
  const scrollViewRef = useRef(null)
  const [debugConsole] = useSetting(SETTINGS.debug_console.key)
  const consoleOverrideSetup = useRef(false)
  const isAtBottom = useRef(true)

  // Console window position
  const panX = useSharedValue(MIN_X)
  const panY = useSharedValue(MIN_Y)
  const panStartX = useSharedValue(0)
  const panStartY = useSharedValue(0)

  // Toggle button position
  const toggleX = useSharedValue(0)
  const toggleY = useSharedValue(0)
  const toggleStartX = useSharedValue(0)
  const toggleStartY = useSharedValue(0)

  const panGesture = Gesture.Pan()
    .onStart(() => {
      panStartX.value = panX.value
      panStartY.value = panY.value
    })
    .onUpdate(event => {
      panX.value = panStartX.value + event.translationX
      panY.value = panStartY.value + event.translationY
    })
    .onEnd(() => {
      if (panY.value < MIN_Y) {
        panY.value = withSpring(MIN_Y)
      }
      if (panX.value < MIN_X) {
        panX.value = withSpring(MIN_X)
      }
    })

  const toggleGesture = Gesture.Pan()
    .onStart(() => {
      toggleStartX.value = toggleX.value
      toggleStartY.value = toggleY.value
    })
    .onUpdate(event => {
      toggleX.value = toggleStartX.value + event.translationX
      toggleY.value = toggleStartY.value + event.translationY
    })

  const panAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{translateX: panX.value}, {translateY: panY.value}],
  }))

  const toggleAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{translateX: toggleX.value}, {translateY: toggleY.value}],
  }))

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent
    const isBottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - 20
    isAtBottom.current = isBottom
  }

  useEffect(() => {
    if (!debugConsole || consoleOverrideSetup.current) {
      return
    }

    const timeoutId = setTimeout(() => {
      const originalLog = console.log
      const originalWarn = console.warn
      const originalError = console.error

      const addLog = (type: any, args: any[]) => {
        const message = args
          .map(arg => (typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)))
          .join(" ")

        setTimeout(() => {
          setLogs(prev => {
            const newLogs = [
              ...prev,
              {
                type,
                message,
                timestamp: new Date().toLocaleTimeString(),
              },
            ]
            return newLogs.slice(-500)
          })
        }, 1000)
      }

      console.log = (...args) => {
        addLog("log", args)
        originalLog(...args)
      }

      console.warn = (...args) => {
        addLog("warn", args)
        originalWarn(...args)
      }

      console.error = (...args) => {
        try {
          addLog("error", args)
          originalError(...args)
        } catch (error) {
          console.log("Error in console.error", error)
        }
      }

      consoleOverrideSetup.current = true
    }, 1000)

    return () => {
      clearTimeout(timeoutId)
    }
  }, [debugConsole])

  if (!debugConsole) {
    return null
  }

  const handleHide = () => {
    setIsVisible(false)
  }

  if (!isVisible) {
    return (
      <GestureDetector gesture={toggleGesture}>
        <Animated.View className="absolute bottom-28 right-2" style={toggleAnimatedStyle}>
          <Button text="Show Console" preset="primary" compact onPress={() => setIsVisible(true)} />
        </Animated.View>
      </GestureDetector>
    )
  }

  return (
    <Animated.View style={[themed($container), panAnimatedStyle]}>
      <GestureDetector gesture={panGesture}>
        <View style={themed($header)}>
          <Text text={`Console (${logs.length}/500)`} className="text-xs font-bold" />
          <View className="flex-row gap-2">
            <Button text="Hide" preset="primary" compact onPress={handleHide} />
            <Button text="Clear" preset="secondary" compact onPress={() => setLogs([])} />
          </View>
        </View>
      </GestureDetector>
      <ScrollView
        ref={scrollViewRef}
        className="flex"
        contentContainerStyle={themed($logContentContainer)}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        onContentSizeChange={() => {
          if (isAtBottom.current) {
            scrollViewRef.current?.scrollToEnd()
          }
        }}>
        {logs.map((log, index) => (
          <View key={index}>
            <Text
              text={log.message}
              className="text-[10px]/3 font-bold color-secondary-foreground font-mono"
              style={[log.type === "error" && themed($errorText), log.type === "warn" && themed($warnText)]}
            />
          </View>
        ))}
      </ScrollView>
    </Animated.View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  position: "absolute",
  left: 0,
  right: 0,
  height: 300,
  width: "90%",
  backgroundColor: colors.primary_foreground,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: spacing.s6,
})

const $header: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  paddingHorizontal: spacing.s6,
  paddingVertical: spacing.s2,
  backgroundColor: colors.background,
  borderRadius: spacing.s6,
  borderBottomLeftRadius: 0,
  borderBottomRightRadius: 0,
  borderBottomWidth: 1,
  borderBottomColor: colors.border,
  borderColor: colors.border,
})

const $logContentContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingHorizontal: spacing.s2,
  paddingBottom: spacing.s3,
  paddingTop: spacing.s2,
})

const $errorText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.error,
})

const $warnText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.warning,
})
