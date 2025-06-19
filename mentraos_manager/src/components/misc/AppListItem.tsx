import React from "react"
import {View, TouchableOpacity, ViewStyle, TextStyle, Animated, Pressable} from "react-native"
import {useAppTheme} from "@/utils/useAppTheme"
import {colors, ThemedStyle} from "@/theme"
import AppIcon from "./AppIcon"
import ChevronRight from "assets/icons/component/ChevronRight"
import SunIcon from "assets/icons/component/SunIcon"
import {TreeIcon} from "assets/icons/component/TreeIcon"
import {translate} from "@/i18n"
import {Switch, Text} from "@/components/ignite"
import {TooltipIcon} from "assets/icons/component/TooltipIcon"
import Toast from "react-native-toast-message"

interface AppModel {
  name: string
  packageName: string
  is_foreground?: boolean
}

interface AppListItemProps {
  app: AppModel
  isActive: boolean
  onTogglePress: () => void
  onSettingsPress: () => void
  refProp?: React.Ref<any>
  is_foreground?: boolean
  opacity?: Animated.AnimatedValue
  height?: Animated.AnimatedValue
  isDisabled?: boolean
}

export const AppListItem = ({
  app,
  isActive,
  onTogglePress,
  onSettingsPress,
  refProp,
  opacity,
  isDisabled,
  is_foreground,
  height,
}: AppListItemProps) => {
  const {themed, theme} = useAppTheme()

  return (
    <Animated.View
      ref={refProp}
      style={[
        themed($everything),
        themed($everythingFlexBox),
        opacity ? {opacity} : {},
        height
          ? {
              height: height.interpolate({
                inputRange: [0, 1],
                outputRange: [0, 72],
              }),
              overflow: "hidden",
            }
          : {},
      ]}>
      <TouchableOpacity
        style={[themed($appDescription), themed($everythingFlexBox)]}
        onPress={onTogglePress}
        disabled={isDisabled}
        activeOpacity={0.7}>
        <AppIcon app={app} isForegroundApp={is_foreground} style={themed($appIcon)} />
        <View style={themed($appNameWrapper)}>
          <Text
            text={app.name}
            style={[themed($appName), isActive ? themed($activeApp) : themed($inactiveApp)]}
            numberOfLines={1}
            ellipsizeMode="tail"
          />
          {is_foreground && <Tag isActive={isActive} isForeground={is_foreground} />}
        </View>
      </TouchableOpacity>

      <View style={[themed($toggleParent), themed($everythingFlexBox)]}>
        <View pointerEvents={isDisabled ? "none" : "auto"}>
          <Switch value={isActive} onValueChange={onTogglePress} />
        </View>
        <TouchableOpacity onPress={onSettingsPress} hitSlop={12} style={themed($chevronHitbox)}>
          <ChevronRight color={theme.colors.text} />
        </TouchableOpacity>
      </View>
    </Animated.View>
  )
}

const $activeApp: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  // "#F7F7F7" : "#CED2ED"
})

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

const Tag = ({isActive, isForeground = false}: {isActive: boolean; isForeground?: boolean}) => {
  const {themed, theme} = useAppTheme()
  const mColor = isActive ? "#7674FB" : theme.colors.textDim

  if (isForeground) {
    return (
      <View style={themed(isActive ? $tagActive : $tag)}>
        <TreeIcon size={16} color={mColor} />
        <Text
          text={isForeground ? translate("home:foreground") : ""}
          style={[themed($disconnect), {color: mColor}]}
          numberOfLines={1}
        />
        <Pressable
          onPress={() => {
            Toast.show({
              type: "baseToast",
              text1: "Not implemented",
              position: "bottom",
            })
          }}></Pressable>
      </View>
    )
  } else {
    return
  }
}
const $tagActive: ThemedStyle<ViewStyle> = ({colors}) => {
  return {
    borderRadius: 15,
    paddingHorizontal: 8,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 4,
    minHeight: 28,
    backgroundColor: colors.palette.primary200,
    alignSelf: "flex-start",
  }
}

const $tag: ThemedStyle<ViewStyle> = () => ({
  borderRadius: 15,
  paddingVertical: 6,
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "flex-start",
  gap: 4,
  minHeight: 28,
  alignSelf: "flex-start",
})

const $disconnect: ThemedStyle<TextStyle> = () => ({
  fontSize: 13,
  letterSpacing: 0.4,
  lineHeight: 16,
  fontWeight: "700",
  color: "#ceced0",
  textAlign: "left",
})

export default Tag
