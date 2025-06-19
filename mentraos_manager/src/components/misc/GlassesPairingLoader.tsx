import React, {useEffect, useRef} from "react"
import {View, Text, StyleSheet, Animated, Easing, useWindowDimensions, ViewStyle, TextStyle} from "react-native"
import Icon from "react-native-vector-icons/FontAwesome"
import {getModelSpecificTips} from "./GlassesTroubleshootingModal"
import MaterialCommunityIcons from "react-native-vector-icons/MaterialCommunityIcons"
import {useAppTheme} from "@/utils/useAppTheme"
import {ThemedStyle} from "@/theme"
import {Header} from "../ignite/Header"
import {router} from "expo-router"

interface GlassesPairingLoaderProps {
  glassesModelName: string
}

const GlassesPairingLoader: React.FC<GlassesPairingLoaderProps> = ({glassesModelName}) => {
  const {width} = useWindowDimensions()
  const {theme, themed} = useAppTheme()

  // Animation values
  const glassesAnim = useRef(new Animated.Value(0)).current
  const signalAnim = useRef(new Animated.Value(0)).current
  const dotAnim1 = useRef(new Animated.Value(0)).current
  const dotAnim2 = useRef(new Animated.Value(0)).current
  const dotAnim3 = useRef(new Animated.Value(0)).current
  const progressAnim = useRef(new Animated.Value(0)).current

  // Animation value for ping-pong motion
  const pingPongAnim = useRef(new Animated.Value(0)).current

  const [currentTipIndex, setCurrentTipIndex] = React.useState(0)
  const progressValue = useRef(0)
  const tipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pingPongDirection = useRef(1) // 1 for right, -1 for left

  const tips = getModelSpecificTips(glassesModelName)

  // Set up all animations
  useEffect(() => {
    // Glasses bobbing animation
    Animated.loop(
      Animated.sequence([
        Animated.timing(glassesAnim, {
          toValue: 1,
          duration: 1500,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.sin),
        }),
        Animated.timing(glassesAnim, {
          toValue: 0,
          duration: 1500,
          useNativeDriver: true,
          easing: Easing.inOut(Easing.sin),
        }),
      ]),
    ).start()

    // Signal waves animation
    Animated.loop(
      Animated.sequence([
        Animated.timing(signalAnim, {
          toValue: 1,
          duration: 2000,
          useNativeDriver: true,
          easing: Easing.out(Easing.ease),
        }),
        Animated.timing(signalAnim, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    ).start()

    // Dots typing effect
    Animated.loop(
      Animated.sequence([
        // First dot
        Animated.timing(dotAnim1, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
        // Second dot
        Animated.timing(dotAnim2, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
        // Third dot
        Animated.timing(dotAnim3, {
          toValue: 1,
          duration: 400,
          useNativeDriver: true,
        }),
        // Pause at full
        Animated.delay(300),
        // Reset all dots
        Animated.parallel([
          Animated.timing(dotAnim1, {
            toValue: 0,
            duration: 400,
            useNativeDriver: true,
          }),
          Animated.timing(dotAnim2, {
            toValue: 0,
            duration: 400,
            useNativeDriver: true,
          }),
          Animated.timing(dotAnim3, {
            toValue: 0,
            duration: 400,
            useNativeDriver: true,
          }),
        ]),
        // Pause when empty
        Animated.delay(300),
      ]),
    ).start()

    // Ping-pong animation function
    const animatePingPong = () => {
      Animated.timing(pingPongAnim, {
        toValue: pingPongDirection.current,
        duration: 1200,
        useNativeDriver: true,
        easing: Easing.inOut(Easing.cubic),
      }).start(() => {
        // Flip direction and continue
        pingPongDirection.current *= -1
        animatePingPong()
      })
    }

    // Start the ping-pong animation
    animatePingPong()

    Animated.timing(progressAnim, {
      toValue: 85,
      duration: 75000,
      useNativeDriver: false,
      easing: Easing.out(Easing.exp),
    }).start()

    // Set up fact rotator
    const rotateTips = () => {
      tipTimerRef.current = setTimeout(() => {
        setCurrentTipIndex(prevIndex => (prevIndex + 1) % tips.length)
        rotateTips()
      }, 8000) // Change tip every 8 seconds
    }

    rotateTips()

    return () => {
      if (tipTimerRef.current) {
        clearTimeout(tipTimerRef.current)
      }
    }
  }, [])

  const signalOpacity = signalAnim.interpolate({
    inputRange: [0, 0.2, 1],
    outputRange: [1, 0.7, 0],
  })

  const signalScale = signalAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 2],
  })

  const dot1Opacity = dotAnim1.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 1],
  })

  const dot2Opacity = dotAnim2.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 1],
  })

  const dot3Opacity = dotAnim3.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 1],
  })

  // Width of the entire animation area
  const ANIMATION_WIDTH = 55

  // Ping-pong animation for dot positions
  // We interpolate based on the pingPongAnim value which goes from -1 to 1

  const dot1Transform = {
    transform: [
      {
        translateX: pingPongAnim.interpolate({
          inputRange: [-1, 0, 1],
          outputRange: [-ANIMATION_WIDTH * 0.9, ANIMATION_WIDTH * 0.35, ANIMATION_WIDTH * 0.9],
        }),
      },
    ],
  }

  // Dot 2 (middle dot)
  const dot2Transform = {
    transform: [
      {
        translateX: pingPongAnim.interpolate({
          inputRange: [-1, 0, 1],
          outputRange: [-ANIMATION_WIDTH * 0.9, 0, ANIMATION_WIDTH * 0.9],
        }),
      },
    ],
  }

  // Dot 3 (last dot)
  const dot3Transform = {
    transform: [
      {
        translateX: pingPongAnim.interpolate({
          inputRange: [-1, 0, 1],
          outputRange: [-ANIMATION_WIDTH * 0.9, -ANIMATION_WIDTH * 0.35, ANIMATION_WIDTH * 0.9],
        }),
      },
    ],
  }

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ["0%", "100%"],
  })

  // Update progress bar listener
  progressAnim.addListener(({value}) => {
    progressValue.current = value
  })

  return (
    <View style={{flex: 1, height: 500}}>
      <View style={themed($container)}>
        <View style={themed($animationContainer)}>
          <View style={themed($signalContainer)}>
            <View>
              <Icon
                name="mobile-phone"
                size={48}
                color={theme.isDark ? "#c7d2fe" : "#4338ca"}
                style={styles.phoneIcon}
              />
            </View>

            {/* Ping-pong bouncing dots between phone and glasses */}
            <View>
              <Animated.View style={[themed($bouncingDot), dot1Transform]} />
              <Animated.View style={[themed($bouncingDot), dot2Transform]} />
              <Animated.View style={[themed($bouncingDot), dot3Transform]} />
            </View>

            <Animated.View>
              <MaterialCommunityIcons
                name="glasses"
                size={48}
                color={theme.isDark ? "#c7d2fe" : "#4338ca"}
                style={styles.glassesIcon}
              />
            </Animated.View>
          </View>
        </View>

        {/* Status text */}
        <View style={themed($statusContainer)}>
          <Text style={themed($statusText)}>Pairing {glassesModelName}</Text>
        </View>

        {/* Progress bar */}
        <View style={themed($progressBarContainer)}>
          <Animated.View style={[themed($progressBar), {width: progressWidth}]} />
        </View>

        {/* Tips carousel */}
        <View style={styles.tipsContainer}>
          <Text style={themed($tipText)}>{tips[currentTipIndex]}</Text>
        </View>
      </View>
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors}) => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  height: 500,
})

const $animationContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  height: 200,
  flexShrink: 1,
  alignContent: "center",
  justifyContent: "center",
  alignItems: "center",
})

const $statusText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 18,
  fontWeight: "600",
  fontFamily: "Montserrat-SemiBold",
  color: colors.text,
})

const $bouncingDot: ThemedStyle<ViewStyle> = ({colors}) => ({
  position: "absolute",
  width: 10,
  height: 10,
  borderRadius: 5,
  // darkBouncingDot: {
  //   backgroundColor: '#a5b4fc',
  // },
  // lightBouncingDot: {
  //   backgroundColor: '#4f46e5',
  // },
  backgroundColor: colors.text,
})

const $signalContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  width: 200,
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
})

const $progressBarContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  width: "100%",
  height: 6,
  borderRadius: 3,
  marginBottom: 40,
  overflow: "hidden",
})

const $statusContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "center",
  marginBottom: 20,
})

const $progressBar: ThemedStyle<ViewStyle> = ({colors}) => ({
  height: "100%",
  borderRadius: 3,
  backgroundColor: colors.palette.primary300,
})

const $tipText: ThemedStyle<TextStyle> = ({colors}) => ({
  textAlign: "center",
  fontSize: 16,
  lineHeight: 24,
  fontFamily: "Montserrat-Regular",
  color: colors.text,
})

const styles = StyleSheet.create({
  animationContainer: {
    alignContent: "center",
    alignItems: "center",
    flexShrink: 1,
    height: 200,
    justifyContent: "center",
    marginBottom: 30,
  },
  container: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },

  darkText: {
    color: "#f9fafb",
  },
  darkTip: {
    color: "#d1d5db",
  },

  dot: {
    fontSize: 24,
    lineHeight: 20,
    marginHorizontal: 2,
  },
  dotsContainer: {
    flexDirection: "row",
  },
  glassesIcon: {
    shadowColor: "#000",
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.2,
    shadowRadius: 3,
  },
  lightText: {
    color: "#1f2937",
  },
  lightTip: {
    color: "#4b5563",
  },
  phoneIcon: {
    shadowColor: "#000",
    shadowOffset: {width: 0, height: 2},
    shadowOpacity: 0.2,
    shadowRadius: 3,
  },
  progressBarContainer: {
    borderRadius: 3,
    height: 6,
    marginBottom: 40,
    overflow: "hidden",
    width: "100%",
  },
  tipText: {
    fontFamily: "Montserrat-Regular",
    fontSize: 16,
    lineHeight: 24,
    textAlign: "center",
  },
  tipsContainer: {
    alignItems: "center",
    height: 80,
    justifyContent: "center",
    paddingHorizontal: 10,
  },
})

export default GlassesPairingLoader
