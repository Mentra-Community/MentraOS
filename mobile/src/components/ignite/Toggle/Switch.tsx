import {useEffect, useMemo, useRef, useCallback, useState} from "react"
import {Animated, Image, ImageStyle, Platform, StyleProp, TextStyle, View, ViewStyle} from "react-native"

import {iconRegistry} from "@/components/ignite/Icon"
import {isRTL} from "@/i18n"
import {$styles} from "@/theme"
import type {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

import {$inputOuterBase, BaseToggleInputProps, Toggle, ToggleProps} from "./Toggle"

export interface SwitchToggleProps extends Omit<ToggleProps<SwitchInputProps>, "ToggleInput"> {
  /**
   * Switch-only prop that adds a text/icon label for on/off states.
   */
  accessibilityMode?: "text" | "icon"
  /**
   * Optional style prop that affects the knob View.
   * Note: `width` and `height` rules should be points (numbers), not percentages.
   */
  inputDetailStyle?: Omit<ViewStyle, "width" | "height"> & {width?: number; height?: number}
}

interface SwitchInputProps extends BaseToggleInputProps<SwitchToggleProps> {
  accessibilityMode?: SwitchToggleProps["accessibilityMode"]
}

/**
 * @param {SwitchToggleProps} props - The props for the `Switch` component.
 * @see [Documentation and Examples]{@link https://docs.infinite.red/ignite-cli/boilerplate/app/components/Switch}
 * @returns {JSX.Element} The rendered `Switch` component.
 */
export function Switch(props: SwitchToggleProps) {
  const {accessibilityMode, ...rest} = props

  const switchInput = useCallback(
    (toggleProps: SwitchInputProps) => {
      return <ModernSwitchInput {...toggleProps} accessibilityMode={accessibilityMode} />
    },
    [accessibilityMode],
  )
  return <Toggle accessibilityRole="switch" {...rest} ToggleInput={switchInput} hitSlop={rest.hitSlop || 16} />
}

function _SwitchInput(props: SwitchInputProps) {
  const {
    on,
    status,
    disabled: _disabled,
    outerStyle: $outerStyleOverride,
    innerStyle: $innerStyleOverride,
    detailStyle: $detailStyleOverride,
  } = props

  const {themed, theme} = useAppTheme()
  const {colors, spacing} = theme

  const animate = useRef(new Animated.Value(on ? 1 : 0)) // Initial value is set based on isActive
  const _opacity = useRef(new Animated.Value(0))
  const trackColorAnim = useRef(new Animated.Value(on ? 1 : 0))

  useEffect(() => {
    // Start knob animation
    Animated.timing(animate.current, {
      toValue: on ? 1 : 0,
      duration: 200, // Faster animation
      useNativeDriver: true, // Enable native driver for smoother animations
    }).start()

    // Delay track color animation to start near the end of knob animation
    setTimeout(() => {
      Animated.timing(trackColorAnim.current, {
        toValue: on ? 1 : 0,
        duration: 50, // Quick color transition at the end
        useNativeDriver: false,
      }).start()
    }, 50) // Start color change 150ms into the 200ms animation
  }, [on])

  // useEffect(() => {
  //   Animated.timing(opacity.current, {
  //     toValue: on ? 1 : 0,
  //     duration: 200, // Match the faster animation speed
  //     useNativeDriver: true,
  //   }).start()
  // }, [on])

  const knobSizeFallback = 2

  const knobWidth = [$detailStyleOverride?.width, $switchDetail?.width, knobSizeFallback].find(
    v => typeof v === "number",
  )

  const knobHeight = [$detailStyleOverride?.height, $switchDetail?.height, knobSizeFallback].find(
    v => typeof v === "number",
  )

  const offBackgroundColor = [status === "error" && colors.errorBackground, colors.switchTrackOff].filter(Boolean)[0]

  const onBackgroundColor = [status === "error" && colors.errorBackground, colors.switchTrackOn].filter(Boolean)[0]

  const knobBackgroundColor = (function () {
    if (on) {
      return [
        // $detailStyleOverride?.backgroundColor,
        status === "error" && colors.error,
        colors.primary, // Use switchThumbOn if available, fallback to switchThumb
      ].filter(Boolean)[0]
    } else {
      return [
        // $innerStyleOverride?.backgroundColor,
        status === "error" && colors.error,
        colors.background,
      ].filter(Boolean)[0]
    }
  })()

  const rtlAdjustment = isRTL ? -1 : 1
  const $themedSwitchInner = useMemo(() => themed([$styles.toggleInner, $switchInner]), [themed])

  const offsetLeft = ($innerStyleOverride?.paddingStart ||
    $innerStyleOverride?.paddingLeft ||
    $themedSwitchInner?.paddingStart ||
    $themedSwitchInner?.paddingLeft ||
    0) as number

  const offsetRight = ($innerStyleOverride?.paddingEnd ||
    $innerStyleOverride?.paddingRight ||
    $themedSwitchInner?.paddingEnd ||
    $themedSwitchInner?.paddingRight ||
    0) as number

  // const offsetLeft = 0
  // const offsetRight = 0

  const _outputRange =
    Platform.OS === "web"
      ? isRTL
        ? [+(knobWidth || 0) + offsetRight, offsetLeft]
        : [offsetLeft, +(knobWidth || 0) + offsetRight]
      : [rtlAdjustment * offsetLeft, rtlAdjustment * (+(knobWidth || 0) + offsetRight)]

  const $animatedSwitchKnob = animate.current.interpolate({
    inputRange: [0, 1],
    // outputRange,
    outputRange: [-12, 12],
  })

  // Interpolate track background color
  const animatedTrackColor = trackColorAnim.current.interpolate({
    inputRange: [0, 1],
    outputRange: [offBackgroundColor, onBackgroundColor],
  })

  return (
    <View style={{alignItems: "center", justifyContent: "center", marginRight: 12}}>
      <Animated.View
        style={[
          $inputOuter,
          {
            backgroundColor: animatedTrackColor,
            borderColor: colors.switchBorder,
            borderWidth: spacing.s0_5,
          },
          $outerStyleOverride,
        ]}></Animated.View>
      <Animated.View
        style={[
          $switchDetail,
          $detailStyleOverride,
          {transform: [{translateX: $animatedSwitchKnob}]},
          {width: knobWidth, height: knobHeight},
          {
            backgroundColor: knobBackgroundColor,
            borderColor: colors.switchBorder,
            borderWidth: theme.spacing.s0_5,
          },
        ]}
      />
    </View>
  )
}

/**
 * Modern iOS-style switch for NEW UI
 */
function ModernSwitchInput(props: SwitchInputProps) {
  const {
    on,
    status,
    disabled: _disabled,
    outerStyle: $outerStyleOverride,
    innerStyle: _$innerStyleOverride,
    detailStyle: $detailStyleOverride,
  } = props

  const {themed: _themed, theme} = useAppTheme()
  const {colors, spacing: _spacing} = theme

  // Use state for simplicity - no native driver conflicts!
  const [animValue] = useState(() => new Animated.Value(on ? 1 : 0))

  useEffect(() => {
    Animated.timing(animValue, {
      toValue: on ? 1 : 0,
      duration: 200,
      useNativeDriver: false, // Use JS driver for everything to avoid conflicts
    }).start()
  }, [on, animValue])

  // iOS-style dimensions (slightly smaller)
  const trackWidth = 46
  const trackHeight = 28
  const knobSize = 24
  const knobMargin = 2

  const offBackgroundColor = [status === "error" && colors.errorBackground, colors.sidebar_border].filter(Boolean)[0]

  const onBackgroundColor = [status === "error" && colors.errorBackground, colors.primary].filter(Boolean)[0]

  const offKnobColor = [status === "error" && colors.error, colors.background].filter(Boolean)[0]

  const onKnobColor = [status === "error" && colors.error, colors.background].filter(Boolean)[0]

  // Calculate all interpolations from single animated value
  const translateX = animValue.interpolate({
    inputRange: [0, 1],
    outputRange: [knobMargin, trackWidth - knobSize - knobMargin],
  })

  const animatedTrackColor = animValue.interpolate({
    inputRange: [0, 1],
    outputRange: [offBackgroundColor, onBackgroundColor],
  })

  const animatedKnobColor = animValue.interpolate({
    inputRange: [0, 1],
    outputRange: [offKnobColor, onKnobColor],
  })

  return (
    <View style={{alignItems: "center", justifyContent: "center"}}>
      <Animated.View
        style={[
          {
            width: trackWidth,
            height: trackHeight,
            borderRadius: trackHeight / 2,
            backgroundColor: animatedTrackColor,
            justifyContent: "center",
          },
          $outerStyleOverride,
        ]}>
        <Animated.View
          style={[
            {
              width: knobSize,
              height: knobSize,
              borderRadius: knobSize / 2,
              backgroundColor: animatedKnobColor,
              position: "absolute",
              transform: [{translateX}],
              shadowColor: "#000",
              shadowOffset: {width: 0, height: 2},
              shadowOpacity: 0.15,
              shadowRadius: 3,
              elevation: 2,
            },
            $detailStyleOverride,
          ]}
        />
      </Animated.View>
    </View>
  )
}

/**
 * @param {ToggleInputProps & { role: "on" | "off" }} props - The props for the `SwitchAccessibilityLabel` component.
 * @returns {JSX.Element} The rendered `SwitchAccessibilityLabel` component.
 */
function _SwitchAccessibilityLabel(props: SwitchInputProps & {role: "on" | "off"}) {
  const {on, disabled, status, accessibilityMode, role, innerStyle, detailStyle} = props

  const {
    theme: {colors},
  } = useAppTheme()

  if (!accessibilityMode) return null

  const shouldLabelBeVisible = (on && role === "on") || (!on && role === "off")

  const $switchAccessibilityStyle: StyleProp<ViewStyle> = [
    $switchAccessibility,
    role === "off" && {end: "5%"},
    role === "on" && {left: "5%"},
  ]

  const color = (function () {
    if (disabled) return colors.palette.neutral600
    if (status === "error") return colors.error
    if (!on) return innerStyle?.backgroundColor || colors.palette.secondary500
    return detailStyle?.backgroundColor || colors.palette.neutral100
  })()

  return (
    <View style={$switchAccessibilityStyle}>
      {accessibilityMode === "text" && shouldLabelBeVisible && (
        <View
          style={[
            role === "on" && $switchAccessibilityLine,
            role === "on" && {backgroundColor: color},
            role === "off" && $switchAccessibilityCircle,
            role === "off" && {borderColor: color},
          ]}
        />
      )}

      {accessibilityMode === "icon" && shouldLabelBeVisible && (
        <Image
          style={[$switchAccessibilityIcon, {tintColor: color}]}
          source={role === "off" ? iconRegistry.hidden : iconRegistry.view}
        />
      )}
    </View>
  )
}

const $inputOuter: StyleProp<ViewStyle> = [$inputOuterBase, {height: 16, width: 32, borderRadius: 16}]

const $switchInner: ThemedStyle<ViewStyle> = ({colors}) => ({
  borderColor: colors.palette.transparent,
  position: "absolute",
  paddingStart: 4,
  paddingEnd: 4,
})

const $switchDetail: SwitchToggleProps["inputDetailStyle"] = {
  borderRadius: 12,
  position: "absolute",
  width: 24,
  height: 24,
}

const $switchAccessibility: TextStyle = {
  width: "40%",
  justifyContent: "center",
  alignItems: "center",
}

const $switchAccessibilityIcon: ImageStyle = {
  width: 14,
  height: 14,
  resizeMode: "contain",
}

const $switchAccessibilityLine: ViewStyle = {
  width: 2,
  height: 12,
}

const $switchAccessibilityCircle: ViewStyle = {
  borderWidth: 2,
  width: 12,
  height: 12,
  borderRadius: 6,
}
