import {useEffect, useRef, useState, cloneElement, isValidElement} from "react"
import {View, ViewStyle, PanResponder, LayoutChangeEvent, TextStyle} from "react-native"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

type ThemedSliderProps = {
  value: number
  min: number
  max: number
  onValueChange: (value: number) => void
  onSlidingComplete: (value: number) => void
  style?: ViewStyle
  icon?: React.ReactNode
  suffix?: string
}

export const ThemedSlider: React.FC<ThemedSliderProps> = ({
  value,
  min,
  max,
  onValueChange,
  onSlidingComplete,
  style,
  icon,
  suffix = "",
}) => {
  const {themed} = useAppTheme()
  const [sliderWidth, setSliderWidth] = useState(0)
  const [internalValue, setInternalValue] = useState(value)
  const sliderPositionRef = useRef({x: 0, y: 0})
  const containerRef = useRef<View>(null)

  const onValueChangeRef = useRef(onValueChange)
  const onSlidingCompleteRef = useRef(onSlidingComplete)
  const isDraggingRef = useRef(false)

  useEffect(() => {
    onValueChangeRef.current = onValueChange
  }, [onValueChange])

  useEffect(() => {
    onSlidingCompleteRef.current = onSlidingComplete
  }, [onSlidingComplete])

  // Only sync with prop value when not dragging
  useEffect(() => {
    if (!isDraggingRef.current) {
      setInternalValue(value)
    }
  }, [value])

  const computeValueFromPageX = (pageX: number) => {
    if (sliderWidth === 0) {
      return value
    }
    const relativeX = pageX - sliderPositionRef.current.x
    const ratio = Math.max(0, Math.min(1, relativeX / sliderWidth))
    return Math.round(min + ratio * (max - min))
  }

  const panResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: evt => {
      isDraggingRef.current = true
      const newValue = computeValueFromPageX(evt.nativeEvent.pageX)
      setInternalValue(newValue)
      onValueChangeRef.current(newValue)
    },
    onPanResponderMove: evt => {
      const newValue = computeValueFromPageX(evt.nativeEvent.pageX)
      setInternalValue(newValue)
      onValueChangeRef.current(newValue)
    },
    onPanResponderRelease: evt => {
      const newValue = computeValueFromPageX(evt.nativeEvent.pageX)
      setInternalValue(newValue)
      onSlidingCompleteRef.current(newValue)
      isDraggingRef.current = false
    },
  })

  const handleLayout = (e: LayoutChangeEvent) => {
    setSliderWidth(e.nativeEvent.layout.width)
    // Measure the absolute position of the slider
    if (containerRef.current) {
      containerRef.current.measureInWindow((x, y, _width, _height) => {
        sliderPositionRef.current = {x, y}
      })
    }
  }

  const fillPercentage = ((internalValue - min) / (max - min)) * 100

  // Calculate icon size based on slider width - shrinks progressively
  const getIconSize = () => {
    if (fillPercentage >= 30) return 22 // Full size
    if (fillPercentage < 15) return 0 // Hidden
    // Scale from 15% to 30%: proportional shrinking
    const scale = (fillPercentage - 15) / 15
    return Math.round(22 * scale)
  }

  const iconSize = getIconSize()
  const shouldShowIcon = iconSize > 0

  // Clone icon with white color and dynamic size for visibility on colored background
  const whiteIcon =
    icon && isValidElement(icon)
      ? cloneElement(icon as React.ReactElement<any>, {color: "#FFFFFF", size: iconSize})
      : icon

  return (
    <View ref={containerRef} style={[themed($container), style]} onLayout={handleLayout} {...panResponder.panHandlers}>
      {/* Inactive track (thin, full width) */}
      <View style={themed($inactiveTrack)} pointerEvents="none" />
      {/* Active track (thick, filled portion with rounded ends) */}
      <View style={[themed($activeTrack), {width: `${fillPercentage}%`}]} pointerEvents="none">
        <View style={themed($handleContent)}>
          <Text
            text={`${internalValue}${suffix}`}
            style={themed($valueText)}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.5}
          />
          {whiteIcon && shouldShowIcon && <View style={themed($iconContainer)}>{whiteIcon}</View>}
        </View>
      </View>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = () => ({
  height: 60,
  justifyContent: "center",
  position: "relative",
  width: "100%",
})

const $inactiveTrack: ThemedStyle<ViewStyle> = ({colors}) => ({
  height: 4,
  backgroundColor: colors.sliderTrackInactive,
  borderRadius: 2,
  width: "100%",
  position: "absolute",
  top: "50%",
  marginTop: -2,
})

const $activeTrack: ThemedStyle<ViewStyle> = ({colors}) => ({
  height: 40,
  backgroundColor: colors.sliderTrackActive,
  borderRadius: 20,
  position: "absolute",
  top: "50%",
  marginTop: -20,
  minWidth: 40,
  paddingHorizontal: 14,
  justifyContent: "center",
  alignItems: "center",
  overflow: "hidden",
})

const $handleContent: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  width: "100%",
})

const $iconContainer: ThemedStyle<ViewStyle> = () => ({
  marginLeft: 8,
})

const $valueText: ThemedStyle<TextStyle> = () => ({
  fontSize: 16,
  fontWeight: "600",
  color: "#FFFFFF",
  flex: 1,
})
