// AppIcon.tsx
import React from "react"
import {View, StyleSheet, TouchableOpacity, ViewStyle} from "react-native"
import {Image} from "expo-image"
import {useNavigation} from "@react-navigation/native"
import {NavigationProps} from "./types"
import {AppInterface} from "@/contexts/AppStatusProvider"
import {router} from "expo-router"
import {useAppTheme} from "@/utils/useAppTheme"
import {Text} from "@/components/ignite"

interface AppIconProps {
  app: AppInterface
  isForegroundApp?: boolean
  onClick?: () => void
  style?: ViewStyle
  showLabel?: boolean
}

const AppIcon: React.FC<AppIconProps> = ({app, isForegroundApp = false, onClick, style, showLabel = false}) => {
  const navigation = useNavigation<NavigationProps>()
  const {theme} = useAppTheme()

  const WrapperComponent = onClick ? TouchableOpacity : View

  return (
    <WrapperComponent
      onPress={onClick}
      activeOpacity={onClick ? 0.7 : undefined}
      style={[styles.container, style]}
      accessibilityLabel={onClick ? `Launch ${app.name}` : undefined}
      accessibilityRole={onClick ? "button" : undefined}>
      <Image
        source={{uri: app.logoURL}}
        style={styles.icon}
        contentFit="cover"
        transition={200}
        cachePolicy="memory-disk"
      />

      {showLabel && (
        <Text
          text={app.name}
          style={[styles.appName, theme.isDark ? styles.appNameDark : styles.appNameLight]}
          numberOfLines={2}
        />
      )}
    </WrapperComponent>
  )
}

const styles = StyleSheet.create({
  appName: {
    fontSize: 11,
    fontWeight: "600",
    lineHeight: 12,
    marginTop: 5,
    textAlign: "left",
  },
  appNameDark: {
    color: "#ced2ed",
  },
  appNameLight: {
    color: "#000000",
  },
  container: {
    width: 50,
    height: 50,
    borderRadius: 25, // Half of width/height for perfect circle
    overflow: "hidden",
  },
  icon: {
    borderRadius: 25,
    height: "100%",
    resizeMode: "cover",
    width: "100%", // Also make the image circular
  },
  squareBadge: {
    alignItems: "center",
    borderRadius: 6,
    height: 20,
    justifyContent: "center",
    position: "absolute",
    right: 3,
    top: -8,
    width: 20,
    zIndex: 3,
  },
})

export default React.memo(AppIcon)
