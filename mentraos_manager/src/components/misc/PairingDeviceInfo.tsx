import React, {useCallback, useRef, useState} from "react"
import {View, Text, ActivityIndicator, Animated, Image, ViewStyle, TextStyle, ImageStyle} from "react-native"
import {useFocusEffect} from "@react-navigation/native"
import {Button} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"
import {useStatus} from "@/contexts/MentraOSStatusProvider"
import {getGlassesImage} from "@/utils/getGlassesImage"

interface PairingDeviceInfoProps {
  glassesModelName: string
}

const PairingDeviceInfo: React.FC<PairingDeviceInfoProps> = ({glassesModelName}) => {
  const fadeAnim = useRef(new Animated.Value(0)).current
  const scaleAnim = useRef(new Animated.Value(0.8)).current
  const slideAnim = useRef(new Animated.Value(-50)).current
  const {themed, theme} = useAppTheme()

  useFocusEffect(
    useCallback(() => {
      fadeAnim.setValue(0)
      scaleAnim.setValue(0.8)
      slideAnim.setValue(-50)

      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 1200,
          useNativeDriver: true,
        }),
        Animated.spring(scaleAnim, {
          toValue: 1,
          friction: 8,
          tension: 60,
          useNativeDriver: true,
        }),
        Animated.timing(slideAnim, {
          toValue: 0,
          duration: 700,
          useNativeDriver: true,
        }),
      ]).start()

      return () => {
        fadeAnim.stopAnimation()
        scaleAnim.stopAnimation()
        slideAnim.stopAnimation()
      }
    }, [fadeAnim, scaleAnim, slideAnim]),
  )

  return (
    <View style={themed($deviceInfoContainer)}>
      <View style={themed($disconnectedContent)}>
        <Image source={getGlassesImage(glassesModelName)} style={themed($glassesImage)} />
        <Text style={themed($connectText)}>{`Searching for ${glassesModelName}`}</Text>
        <ActivityIndicator size="small" color={theme.colors.palette.primary300} />
      </View>
    </View>
  )
}

// Define themed styles using ThemedStyle type
const $deviceInfoContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  paddingBottom: 4,
  paddingTop: 16,
  borderRadius: 16,
  width: "100%",
  minHeight: 180,
  justifyContent: "center",
  marginTop: 16,
  backgroundColor: colors.background,
})

const $disconnectedContent: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
})

const $glassesImage: ThemedStyle<ImageStyle> = () => ({
  width: "80%",
  height: "40%",
  resizeMode: "contain",
})

const $connectText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  fontWeight: "bold",
  marginBottom: 10,
  marginTop: 36,
  fontFamily: "Montserrat-Bold",
  color: colors.text,
})

export default PairingDeviceInfo
