/**
 * MiniappOpenWait — the splash of a miniapp the person opened before it could open: a default miniapp still
 * installing (Home shows those as if installed), or a miniapp whose update is installing. It slides in as a miniapp
 * opens, says what it waits for under the icon, and once the miniapp can open, opens it in place: the Compositor's
 * overlay, mounted above this one with the same splash, takes over without an animation.
 */
import {engine, useApps} from "@mentra/engine"
import {useEffect, useRef} from "react"
import {BackHandler, Platform, Pressable, useWindowDimensions} from "react-native"
import Animated, {Easing, useAnimatedStyle, useSharedValue, withTiming} from "react-native-reanimated"

import {Icon} from "@/components/ignite"
import MiniappSplash from "@/components/miniapp/MiniappSplash"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import {translate} from "@/i18n"
import {defaultMiniapps} from "@/services/miniapps/defaultMiniapps"
import {useDefaultMiniappsStore} from "@/stores/defaultMiniapps"
import {
  endMiniappOpenWait,
  miniappOpenWaitPhase,
  type MiniappOpenWait as Wait,
  type MiniappOpenWaitPhase,
  useMiniappOpenWaitStore,
} from "@/stores/miniappOpenWait"

const SLIDE_DURATION_MS = Platform.OS === "ios" ? 300 : 260

export function MiniappOpenWait() {
  const wait = useMiniappOpenWaitStore((state) => state.wait)
  if (!wait) return null
  return <WaitingSplash key={wait.id} wait={wait} />
}

function label(phase: MiniappOpenWaitPhase): string | undefined {
  switch (phase) {
    case "installing":
      return translate("home:miniappInstalling")
    case "updating":
      return translate("home:miniappUpdating")
    case "waiting":
      return translate("home:miniappWaitingForConnection")
    default:
      return undefined
  }
}

function WaitingSplash({wait}: {wait: Wait}) {
  const {theme} = useAppTheme()
  const insets = useSaferAreaInsets()
  const {width} = useWindowDimensions()
  const apps = useApps()
  const status = useDefaultMiniappsStore((state) => state.status)
  const pending = useDefaultMiniappsStore((state) => state.pending)
  const failed = useDefaultMiniappsStore((state) => state.failed)
  const installed = apps.find((app) => app.packageName === wait.packageName)
  const phase = miniappOpenWaitPhase(wait.packageName, installed, {status, pending, failed})

  const translateX = useSharedValue(width)
  useEffect(() => {
    translateX.value = withTiming(0, {duration: SLIDE_DURATION_MS, easing: Easing.out(Easing.cubic)})
  }, [translateX])
  const animatedStyle = useAnimatedStyle(() => ({transform: [{translateX: translateX.value}]}))

  // A default the person waits for installs next.
  useEffect(() => {
    if (!installed && pending.includes(wait.packageName)) defaultMiniapps.prioritize(wait.packageName)
    // Only when the wait starts: later passes keep the priority until it installs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wait.packageName])

  // Open once it can, in place; the wait ends whatever the open does.
  const opening = useRef(false)
  useEffect(() => {
    if (phase !== "ready" || opening.current) return
    opening.current = true
    const app = engine.miniapps.list().find((candidate) => candidate.packageName === wait.packageName)
    if (!app) {
      opening.current = false
      return
    }
    wait
      .open(app)
      .catch((error) => console.warn(`MiniappOpenWait: could not open ${wait.packageName}`, error))
      .finally(() => endMiniappOpenWait(wait.id))
  }, [phase, wait])

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (opening.current) return true
      endMiniappOpenWait(wait.id)
      return true
    })
    return () => subscription.remove()
  }, [wait.id])

  return (
    // Under the Compositor (zIndex 10, mounted after this one), over everything before it.
    <Animated.View
      style={[{position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: 10}, animatedStyle]}
      // A screen reader stays on the splash: Home behind it isn't there for the person.
      accessibilityViewIsModal={true}
      testID="miniapp-open-wait">
      <MiniappSplash
        name={installed?.name ?? wait.name}
        iconUrl={installed?.logoUrl || wait.iconUrl}
        bgColor={theme.colors.background}
        label={label(phase)}
        error={phase === "failed" ? translate("home:miniappInstallFailed", {app: wait.name}) : undefined}
        disableFadeIn={true}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={translate("common:close")}
        testID="miniapp-open-wait.close"
        hitSlop={12}
        onPress={() => {
          if (!opening.current) endMiniappOpenWait(wait.id)
        }}
        style={{position: "absolute", top: insets.top + 12, left: 16, padding: 8}}>
        <Icon name="x" size={24} color={theme.colors.text} />
      </Pressable>
    </Animated.View>
  )
}
