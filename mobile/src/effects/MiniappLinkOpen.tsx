/**
 * MiniappLinkOpen — the splash of a miniapp a person opens from a link. It slides in as a miniapp opens, before the
 * app knows which miniapp the link names, shows the miniapp's icon and name once its `miniapp.json` is read, and
 * stays up while it installs. The miniapp then opens in place: the Compositor's overlay, under this one with the same
 * splash, is what the person sees when this one closes. Closing it (the button, or Android back) stops the link.
 */
import {useEffect} from "react"
import {BackHandler, Platform, Pressable, useWindowDimensions} from "react-native"
import Animated, {Easing, useAnimatedStyle, useSharedValue, withTiming} from "react-native-reanimated"

import {Icon} from "@/components/ignite"
import MiniappSplash from "@/components/miniapp/MiniappSplash"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {cancelMiniappLinkOpens, type MiniappLinkOpenView, useMiniappLinkOpenStore} from "@/stores/miniappLinkOpen"

const SLIDE_DURATION_MS = Platform.OS === "ios" ? 300 : 260

export function MiniappLinkOpen() {
  const view = useMiniappLinkOpenStore((state) => state.view)
  if (!view) return null
  return <OpeningSplash key={view.id} view={view} />
}

function OpeningSplash({view}: {view: MiniappLinkOpenView}) {
  const {theme} = useAppTheme()
  const insets = useSaferAreaInsets()
  const {width} = useWindowDimensions()

  const translateX = useSharedValue(width)
  useEffect(() => {
    translateX.value = withTiming(0, {duration: SLIDE_DURATION_MS, easing: Easing.out(Easing.cubic)})
  }, [translateX])
  const animatedStyle = useAnimatedStyle(() => ({transform: [{translateX: translateX.value}]}))

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      cancelMiniappLinkOpens()
      return true
    })
    return () => subscription.remove()
  }, [])

  return (
    // Over the Compositor (zIndex 10): a miniapp in front stays as it is until the link's miniapp opens over it.
    <Animated.View
      style={[{position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: 11}, animatedStyle]}
      // A screen reader stays on the splash: what is behind it isn't there for the person.
      accessibilityViewIsModal={true}
      testID="miniapp-link-open">
      <MiniappSplash
        name={view.name}
        iconUrl={view.iconUrl}
        bgColor={theme.colors.background}
        label={translate(view.installing ? "home:miniappInstalling" : "miniappInstall:opening")}
        disableFadeIn={true}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={translate("common:close")}
        testID="miniapp-link-open.close"
        hitSlop={12}
        onPress={cancelMiniappLinkOpens}
        style={{position: "absolute", top: insets.top + 12, left: 16, padding: 8}}>
        <Icon name="x" size={24} color={theme.colors.text} />
      </Pressable>
    </Animated.View>
  )
}
