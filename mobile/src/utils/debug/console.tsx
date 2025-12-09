import {useState, useEffect, useRef} from "react"
import {
  ScrollView,
  TouchableOpacity,
  View,
  PanResponder,
  Animated,
  ViewStyle,
  TextStyle,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from "react-native"

import {Text} from "@/components/ignite/Text"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

export const ConsoleLogger = () => {
  const {themed} = useAppTheme()
  const [logs, setLogs] = useState([])
  const [isVisible, setIsVisible] = useState(false)
  const scrollViewRef = useRef(null)
  const [debugConsole] = useSetting(SETTINGS.debug_console.key)
  const consoleOverrideSetup = useRef(false)
  const isAtBottom = useRef(true)

  const pan = useRef(new Animated.ValueXY({x: 0, y: 50})).current
  const toggleButtonPan = useRef(new Animated.ValueXY({x: 0, y: 0})).current

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_evt, _gestureState) => {
        // Only set pan responder if the gesture has moved significantly
        // return Math.abs(gestureState.dx) > 5 || Math.abs(gestureState.dy) > 5
        return false
      },
      onPanResponderGrant: () => {
        pan.setOffset({
          x: pan.x._value,
          y: pan.y._value,
        })
        pan.setValue({x: 0, y: 0})
      },
      onPanResponderMove: Animated.event([null, {dx: pan.x, dy: pan.y}], {useNativeDriver: false}),
      onPanResponderRelease: () => {
        pan.flattenOffset()
      },
    }),
  ).current

  const toggleButtonPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (evt, gestureState) => {
        // Only set pan responder if the gesture has moved significantly
        return Math.abs(gestureState.dx) > 5 || Math.abs(gestureState.dy) > 5
        // return true
      },
      onPanResponderGrant: () => {
        toggleButtonPan.setOffset({
          x: toggleButtonPan.x._value,
          y: toggleButtonPan.y._value,
        })
        toggleButtonPan.setValue({x: 0, y: 0})
      },
      onPanResponderMove: Animated.event([null, {dx: toggleButtonPan.x, dy: toggleButtonPan.y}], {
        useNativeDriver: false,
      }),
      onPanResponderRelease: () => {
        toggleButtonPan.flattenOffset()
      },
    }),
  ).current

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const {contentOffset, contentSize, layoutMeasurement} = event.nativeEvent
    const isBottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - 20
    isAtBottom.current = isBottom
  }

  useEffect(() => {
    // Only override console if debugConsole is enabled and we haven't set it up yet
    if (!debugConsole || consoleOverrideSetup.current) {
      return
    }

    // Use setTimeout to ensure React DevTools initializes first
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
      // console.log = originalLog
      // console.warn = originalWarn
      // console.error = originalError
    }
  }, [debugConsole])

  if (!debugConsole) {
    return null
  }

  const handleHide = () => {
    setIsVisible(false)
    // Reset toggle button position to default when hiding
    // toggleButtonPan.setValue({x: 0, y: 0})
  }

  if (!isVisible) {
    return (
      <Animated.View
        style={[
          themed($toggleButton),
          {
            transform: [{translateX: toggleButtonPan.x}, {translateY: toggleButtonPan.y}],
          },
        ]}
        {...toggleButtonPanResponder.panHandlers}>
        <TouchableOpacity onPress={() => setIsVisible(true)}>
          <Text text="Show Console" style={themed($toggleButtonText)} />
        </TouchableOpacity>
      </Animated.View>
    )
  }

  return (
    <Animated.View
      style={[
        themed($container),
        {
          transform: [{translateX: pan.x}, {translateY: pan.y}],
        },
      ]}>
      <View style={themed($header)} {...panResponder.panHandlers}>
        <Text text={`Console (${logs.length}/500) - Drag to move`} style={themed($headerText)} weight="bold" />
        <View style={themed($headerButtons)}>
          <TouchableOpacity style={themed($clearButton)} onPress={() => setLogs([])}>
            <Text text="Clear" style={themed($buttonText)} />
          </TouchableOpacity>
          <TouchableOpacity style={themed($hideButton)} onPress={handleHide}>
            <Text text="Hide" style={themed($buttonText)} />
          </TouchableOpacity>
        </View>
      </View>
      <ScrollView
        ref={scrollViewRef}
        style={themed($logContainer)}
        contentContainerStyle={themed($logContentContainer)}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        onContentSizeChange={() => {
          if (isAtBottom.current) {
            scrollViewRef.current?.scrollToEnd()
          }
        }}>
        {logs.map((log, index) => (
          <View key={index} style={themed($logEntry)}>
            {/*<Text text={log.timestamp} style={themed($timestamp)} />*/}
            <Text
              text={log.message}
              style={[
                themed($logText),
                log.type === "error" && themed($errorText),
                log.type === "warn" && themed($warnText),
              ]}
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

const $headerText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  color: colors.text,
  fontSize: spacing.s3,
})

const $headerButtons: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  gap: spacing.s6,
})

const $clearButton: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  paddingHorizontal: spacing.s3,
  paddingVertical: spacing.s1,
  borderRadius: spacing.s2,
})

const $hideButton: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.palette.neutral400,
  paddingHorizontal: spacing.s3,
  paddingVertical: spacing.s1,
  borderRadius: spacing.s2,
})

const $buttonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 12,
})

const $logContainer: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $logContentContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingHorizontal: spacing.s2,
  paddingBottom: spacing.s3,
  paddingTop: spacing.s2,
})

const $logEntry: ThemedStyle<ViewStyle> = () => ({
  // marginBottom: spacing.s1,
})

const $logText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.secondary_foreground,
  fontFamily: "monospace",
  fontSize: 10,
  lineHeight: 12,
  fontWeight: 800,
})

const $errorText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.error,
})

const $warnText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.warning,
})

const $toggleButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  position: "absolute",
  bottom: 100,
  right: 8,
  backgroundColor: colors.palette.neutral100,
  paddingHorizontal: 16,
  paddingVertical: 8,
  borderRadius: 8,
  borderWidth: 1,
  borderColor: colors.border,
})

const $toggleButtonText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 12,
  fontWeight: "bold",
})
