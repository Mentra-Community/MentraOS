import React from "react"
import {TouchableOpacity, View, ViewStyle, TextStyle} from "react-native"
import {useAppTheme} from "@/utils/useAppTheme"
import {ThemedStyle} from "@/theme"
import ChevronRight from "assets/icons/component/ChevronRight"
import {Text} from "@/components/ignite"
import {router} from "expo-router"
import StoreIcon from "assets/icons/navbar/StoreIcon"
import {Icon} from "@/components/ignite"

interface AppListStoreLinkProps {
  onPress?: () => void
}

export const AppListStoreLink = ({onPress}: AppListStoreLinkProps) => {
  const {themed, theme} = useAppTheme()

  const handlePress = () => {
    if (onPress) {
      onPress()
    } else {
      router.push("/(tabs)/store")
    }
  }

  return (
    <TouchableOpacity
      style={[themed($everything), themed($everythingFlexBox)]}
      onPress={handlePress}
      activeOpacity={0.7}>
      <View style={[themed($appDescription), themed($everythingFlexBox)]}>
        <View style={themed($iconContainer)}>
          <StoreIcon size={30} color={theme.colors.text} />
          <View style={themed($plusBadge)}>
            <Icon icon="plus" size={12} color="white" />
          </View>
        </View>
        <View style={themed($appNameWrapper)}>
          <Text
            text="Get More Apps"
            style={[themed($appName), themed($inactiveApp)]}
            numberOfLines={1}
            ellipsizeMode="tail"
          />
        </View>
      </View>
      <View style={[themed($toggleParent), themed($everythingFlexBox)]}>
        <TouchableOpacity onPress={handlePress} hitSlop={12} style={themed($chevronHitbox)}>
          <ChevronRight color={theme.colors.text} />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  )
}

const $inactiveApp: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
})

const $everything: ThemedStyle<ViewStyle> = () => ({
  justifyContent: "space-between",
  gap: 0,
  alignSelf: "stretch",
  height: 72,
})

const $everythingFlexBox: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  alignItems: "center",
})

const $appDescription: ThemedStyle<ViewStyle> = () => ({
  gap: 17,
  justifyContent: "center",
  flex: 1,
})

const $appIcon: ThemedStyle<ViewStyle> = () => ({
  width: 48,
  height: 48,
})

const $iconContainer: ThemedStyle<ViewStyle> = ({colors}) => ({
  width: 48,
  height: 48,
  borderRadius: 24,
  backgroundColor: colors.palette.neutral200,
  justifyContent: "center",
  alignItems: "center",
  position: "relative",
})

const $plusBadge: ThemedStyle<ViewStyle> = ({colors}) => ({
  position: "absolute",
  top: -2,
  right: -2,
  width: 18,
  height: 18,
  borderRadius: 9,
  backgroundColor: colors.palette.primary500,
  justifyContent: "center",
  alignItems: "center",
  borderWidth: 2,
  borderColor: colors.background,
})

const $appNameWrapper: ThemedStyle<ViewStyle> = () => ({
  justifyContent: "center",
  flex: 1,
  marginRight: 16,
})

const $appName: ThemedStyle<TextStyle> = () => ({
  fontSize: 15,
  letterSpacing: 0.6,
  lineHeight: 20,
  textAlign: "left",
  overflow: "hidden",
})

const $toggleParent: ThemedStyle<ViewStyle> = () => ({
  gap: 12,
})

const $chevronHitbox: ThemedStyle<ViewStyle> = () => ({
  padding: 8,
  margin: -8,
})
