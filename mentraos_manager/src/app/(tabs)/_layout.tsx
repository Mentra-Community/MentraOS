import React, {useRef} from "react"
import {withLayoutContext} from "expo-router"
import {
  createNativeBottomTabNavigator,
  NativeBottomTabNavigationOptions,
  NativeBottomTabNavigationEventMap,
} from "@bottom-tabs/react-navigation"
import {ParamListBase, TabNavigationState} from "@react-navigation/native"
import {translate} from "@/i18n"
import {colors, spacing, ThemedStyle, typography} from "@/theme"
import {TextStyle, TouchableOpacity, View, ViewStyle} from "react-native"
import {useSafeAreaInsets} from "react-native-safe-area-context"
import {useAppTheme, useThemeProvider} from "@/utils/useAppTheme"
import {LinearGradient} from "expo-linear-gradient"
import SolarLineIconsSet4 from "assets/icons/component/SolarLineIconsSet4"
import HomeIcon from "assets/icons/navbar/HomeIcon"
import MirrorIcon from "assets/icons/navbar/MirrorIcon"
import StoreIcon from "assets/icons/navbar/StoreIcon"
import UserIcon from "assets/icons/navbar/UserIcon"
import showAlert from "@/utils/AlertUtils"
import Toast from "react-native-toast-message"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {SETTINGS_KEYS} from "@/consts"
import {saveSetting} from "@/utils/SettingsHelper"

// Create the native bottom tab navigator
const BottomTabNavigator = createNativeBottomTabNavigator().Navigator

const Tabs = withLayoutContext<
  NativeBottomTabNavigationOptions,
  typeof BottomTabNavigator,
  TabNavigationState<ParamListBase>,
  NativeBottomTabNavigationEventMap
>(BottomTabNavigator)

export default function Layout() {
  const {bottom} = useSafeAreaInsets()
  const {themeScheme} = useThemeProvider()
  const {theme, themed} = useAppTheme()
  const {push, replace} = useNavigationHistory()
  
  return (
    <Tabs
      screenOptions={{
        // Native bottom tabs styling
        tabBarActiveTintColor: theme.colors.text,

      }}>
      <Tabs.Screen
        name="home"
        options={{
          title: translate("navigation:home"),
          // tabBarIcon: ({focused}) => ({sfSymbol: "house"}),
          tabBarIcon: ({focused}) => require("assets/icons/home.svg"),
        }}
      />

      <Tabs.Screen
        name="glasses"
        options={{
          title: translate("navigation:glasses"),
          // tabBarIcon: ({focused}) => ({
          //   sfSymbol: "eyeglasses",
          // }),
          tabBarIcon: ({focused}) => require("assets/icons/glasses.svg"),
        }}
      />

      <Tabs.Screen
        name="store"
        options={{
          title: translate("navigation:store"),
          // tabBarIcon: ({focused}) => ({
          //   sfSymbol: "storefront",
          // }),
          tabBarIcon: ({focused}) => require("assets/icons/shopping-bag.svg"),
        }}
      />

      <Tabs.Screen
        name="settings"
        options={{
          title: translate("navigation:account"),
          // tabBarIcon: ({focused}) => ({
          //   sfSymbol: "person.crop.circle",
          // }),
          tabBarIcon: ({focused}) => require("assets/icons/user.svg"),
        }}
      />
    </Tabs>
  )
}
