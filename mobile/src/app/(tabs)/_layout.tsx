import {TabList, Tabs, TabSlot, TabTrigger, TabTriggerSlotProps} from "expo-router/ui"
import {Pressable, View} from "react-native"
import {useSafeAreaInsets} from "react-native-safe-area-context"

import {Icon, IconTypes, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"

type TabButtonProps = TabTriggerSlotProps & {
  iconName: IconTypes
  iconNameFilled: IconTypes
  label: string
}

export default function Layout() {
  const {theme} = useAppTheme()
  const {bottom} = useSafeAreaInsets()

  function TabButton({iconName, iconNameFilled, isFocused, label, ...props}: TabButtonProps) {
    let iconColor = isFocused ? theme.colors.primary_foreground : theme.colors.muted_foreground
    let iconBgColor = "transparent"
    if (iconName === "house") {
      iconColor = isFocused ? theme.colors.primary : theme.colors.muted_foreground
      iconBgColor = theme.colors.primary_foreground
    }
    if (iconName === "shopping-bag") {
      if (isFocused) {
        iconColor = theme.colors.primary
        iconBgColor = theme.colors.primary_foreground
      }
    }
    const textColor = isFocused ? theme.colors.secondary_foreground : theme.colors.muted_foreground
    const bottomBarColor = theme.colors.primary_foreground + "01"
    const backgroundColor = isFocused ? theme.colors.primary : bottomBarColor
    const displayIcon = isFocused ? iconNameFilled : iconName
    return (
      <Pressable
        {...props}
        className="flex-col flex-1 gap-1 justify-between items-center"
        style={{marginBottom: bottom}}>
        <View className="px-3 py-1 rounded-2xl" style={{backgroundColor: backgroundColor}}>
          <Icon name={displayIcon} size={24} color={iconColor} backgroundColor={iconBgColor} />
        </View>
        <Text text={label} className="text-sm font-medium" style={{color: textColor}} />
      </Pressable>
    )
  }

  return (
    <Tabs>
      <TabSlot />
      <TabList className="w-full py-2 px-3 bg-primary-foreground">
        <TabTrigger name="home" href="/home" asChild>
          <TabButton iconName="house" iconNameFilled="house-filled" label={translate("navigation:home")} />
        </TabTrigger>
        <TabTrigger name="store" href="/store" asChild>
          <TabButton
            iconName="shopping-bag"
            iconNameFilled="shopping-bag-filled"
            label={translate("navigation:store")}
          />
        </TabTrigger>
        <TabTrigger name="account" href="/account" className="justify-center items-center" asChild>
          <TabButton iconName="user" iconNameFilled="user-filled" label={translate("navigation:account")} />
        </TabTrigger>
      </TabList>
    </Tabs>
  )
}
