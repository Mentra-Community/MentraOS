import {TabList, Tabs, TabSlot, TabTrigger, TabTriggerSlotProps} from "expo-router/ui"
import {Pressable, TextStyle, View, ViewStyle} from "react-native"
import {useSafeAreaInsets} from "react-native-safe-area-context"

import {Icon, IconTypes, Text} from "@/components/ignite"
import {translate} from "@/i18n"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

type TabButtonProps = TabTriggerSlotProps & {
  iconName: IconTypes
  iconNameFilled: IconTypes
  label: string
}

export default function Layout() {
  const {theme, themed} = useAppTheme()
  const {bottom} = useSafeAreaInsets()

  function TabButton({iconName, iconNameFilled, isFocused, label, ...props}: TabButtonProps) {
    const iconColor = isFocused ? theme.colors.background : theme.colors.muted_foreground
    const textColor = isFocused ? theme.colors.secondary_foreground : theme.colors.muted_foreground
    const iconBgColor = isFocused ? theme.colors.primary : theme.colors.primary_foreground
    const displayIcon = isFocused ? iconNameFilled : iconName
    return (
      <Pressable {...props} style={[themed($tabButton), {marginBottom: bottom}]}>
        <View style={[themed($icon), {backgroundColor: iconBgColor}]}>
          <Icon name={displayIcon} size={24} color={iconColor} />
        </View>
        <Text text={label} style={[themed($tabLabel), {color: textColor}]} />
      </Pressable>
    )
  }

  return (
    <Tabs>
      <TabSlot />
      <TabList style={themed($tabList)}>
        <TabTrigger name="home" href="/home" style={themed($tabTrigger)} asChild>
          <TabButton iconName="home" iconNameFilled="home-filled" label={translate("navigation:home")} />
        </TabTrigger>
        <TabTrigger name="store" href="/store" style={themed($tabTrigger)} asChild>
          <TabButton
            iconName="shopping-bag"
            iconNameFilled="shopping-bag-filled"
            label={translate("navigation:store")}
          />
        </TabTrigger>
        <TabTrigger name="account" href="/account" style={themed($tabTrigger)} asChild>
          <TabButton iconName="user" iconNameFilled="user-filled" label={translate("navigation:account")} />
        </TabTrigger>
      </TabList>
    </Tabs>
  )
}

const $icon: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingHorizontal: spacing.s3,
  paddingVertical: spacing.s1,
  borderRadius: spacing.s4,
})

const $tabList: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  borderTopColor: colors.separator,
  paddingVertical: spacing.s2,
  paddingHorizontal: spacing.s3,
  // transparent nav bar:
  backgroundColor: colors.primary_foreground + "fb",
  // position: "absolute",
  // bottom: 0,
})

const $tabTrigger: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  paddingVertical: spacing.s2,
})

const $tabLabel: ThemedStyle<TextStyle> = ({typography}) => ({
  fontSize: 12,
  fontFamily: typography.primary.medium,
})

const $tabButton: ThemedStyle<ViewStyle> = ({spacing}) => ({
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexDirection: "column",
  gap: spacing.s1,
  flex: 1,
})
