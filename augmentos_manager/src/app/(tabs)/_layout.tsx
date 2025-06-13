import React from "react"
import {Tabs} from "expo-router/tabs"
import {translate} from "@/i18n"
import {colors, spacing, ThemedStyle, typography} from "@/theme"
import {TextStyle, View, ViewStyle} from "react-native"
import {useSafeAreaInsets} from "react-native-safe-area-context"
import {useAppTheme, useThemeProvider} from "@/utils/useAppTheme"
import {LinearGradient} from "expo-linear-gradient"
import SolarLineIconsSet4 from "assets/icons/component/SolarLineIconsSet4"
import HomeIcon from "assets/icons/navbar/HomeIcon"
import MirrorIcon from "assets/icons/navbar/MirrorIcon"
import StoreIcon from "assets/icons/navbar/StoreIcon"
import UserIcon from "assets/icons/navbar/UserIcon"

export default function Layout() {
  const {bottom} = useSafeAreaInsets()

  const {themeScheme} = useThemeProvider()
  const {theme, themed} = useAppTheme()

  const showLabel = false
  const iconFocusedColor = theme.isDark ? "white": theme.colors.palette.primary300;
  const whiteColor = "#fff"
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: true,
        tabBarShowLabel: true,
        tabBarStyle: [
          themed($tabBar),
          {
            paddingBottom: bottom + 16,
            // borderTopColor moved to View wrapping LinearGradient
            borderTopWidth: 0,
            backgroundColor: 'transparent',
          },
        ],
        tabBarActiveTintColor: theme.isDark ? whiteColor : theme.colors.text,
        tabBarInactiveTintColor: theme.colors.textDim,
        tabBarLabelStyle: themed($tabBarLabel),
        tabBarItemStyle: themed($tabBarItem),
        tabBarLabelPosition: "below-icon",
        // tabBarPosition: 'left',
        // animation: 'shift',
        // tabBarBackground: () => <View />,
        tabBarBackground: () => (
          <View
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
              borderTopColor: theme.colors.separator,
              borderTopWidth: 2,
              overflow: "hidden",
            }}
          >
            <LinearGradient
              colors={ theme.isDark ? [theme.colors.tabBarBackground1, theme.colors.tabBarBackground2] : [whiteColor, whiteColor]}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: 0,
                bottom: 0,
              }}
              start={{x: 0, y: 0}}
              end={{x: 0, y: 2}}
            />
          </View>
        ),
      }}>
      <Tabs.Screen
        name="home"
        options={{
          href: "/home",  
          headerShown: false,
          tabBarIcon: ({focused, color}) => <HomeIcon size={28} color={focused ? (iconFocusedColor) : colors.textDim} />,
          tabBarLabel: translate("navigation:home"),
        }}
      />
      <Tabs.Screen
        name="glasses"
        options={{
          href: "/glasses",
          headerShown: false,
          tabBarIcon: ({focused, color}) => <SolarLineIconsSet4 size={28} color={focused ? (iconFocusedColor ) : colors.textDim} />,
          tabBarLabel: translate("navigation:glasses"),
        }}
      />
      <Tabs.Screen
        name="mirror"
        options={{
          href: "/mirror",
          headerShown: false,
          tabBarIcon: ({focused, color}) => <MirrorIcon size={28} color={focused ? (iconFocusedColor ) : colors.textDim} />,
          tabBarLabel: translate("navigation:mirror"),
        }}
      />
      <Tabs.Screen
        name="store"
        options={{
          href: "/store",
          headerShown: false,
          tabBarIcon: ({focused, color}) => <StoreIcon size={28} color={focused ? (iconFocusedColor ) : colors.textDim} />,
          tabBarLabel: translate("navigation:store"),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          href: "/settings",
          headerShown: false,
          tabBarIcon: ({focused, color}) => <UserIcon size={28} color={focused ? (iconFocusedColor ) : colors.textDim} />,
          tabBarLabel: translate("navigation:account"),
        }}
      />
    </Tabs>
  )
}

const $tabBar: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.background,
  borderTopColor: colors.separator,
  borderTopWidth: 1,
  paddingTop: 8,
  height: 80,
})

const $tabBarItem: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  paddingTop: spacing.md, // Center icons vertically
  paddingBottom: spacing.md,
})

const $tabBarLabel: ThemedStyle<TextStyle> = ({colors, typography}) => ({
  fontSize: 12,
  fontFamily: typography.primary.medium,
  lineHeight: 16,
  flex: 1,
})
