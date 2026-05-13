import {Image} from "expo-image"
import {useLocalSearchParams} from "expo-router"
import {SquircleView} from "expo-squircle-view"
import {View} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {useNavigationStore} from "@/stores/navigation"
import {useApps} from "@mentra/island"
import {decideDevLaunchRoute} from "@mentra/island"
import {storage} from "@/utils/storage/storage"
import {useRegisterCapsule} from "@/stores/capsule"
import {useRef} from "react"

/**
 * Shown when a dev miniapp is launched while the dev server is unreachable.
 * Visual language matches MiniappSplash — same 128px squircle icon, same
 * centered minimalism — so it reads as "the miniapp tried to load and
 * couldn't" rather than a settings screen with an error.
 *
 *   "Try again"  — re-launch the miniapp; if the dev server is now reachable,
 *                  the local route mounts live and silently snapshots the
 *                  bundle to disk so future offline launches can fall back.
 *   "Re-scan QR" — open the scanner; new QR replaces the old dev URL.
 */
export default function DevMiniappOfflineScreen() {
  const {packageName, name, iconUrl} = useLocalSearchParams<{
    packageName: string
    name?: string
    iconUrl?: string
  }>()
  const {goBack, replace, push} = useNavigationStore.getState()
  const apps = useApps()
  const viewShotRef = useRef<View>(null)

  useRegisterCapsule({
    packageName,
    viewShotRef,
    visibleOnRoutes: ["/applet/dev-offline"],
  })

  // Fall back to the store entry's logoUrl/name if the route didn't carry
  // them. The store entry is populated by Composer.getLocalApplets from the
  // on-disk icon.png + miniapp.json — works even when the dev server is down.
  const fromStore = packageName ? apps.find((a) => a.packageName === packageName) : undefined
  const resolvedIconUrl = iconUrl || fromStore?.logoUrl || undefined
  const resolvedName = name || fromStore?.name

  const lastReachable = packageName ? storage.load<number>(`${packageName}_dev_last_reachable`) : null

  const lastReachableLabel = lastReachable && lastReachable.is_ok() ? formatRelative(lastReachable.value) : "never"

  const onTryAgain = async () => {
    if (!packageName) return
    const devUrlRes = storage.load<string>(`${packageName}_dev_url`)
    if (!devUrlRes.is_ok()) {
      push("/miniapps/settings/miniapp-developer-scanner")
      return
    }
    // Pre-flight reachability before deciding the route. If still down,
    // stay on the offline screen (no-op) so the user can try again or
    // re-scan. If up, replace into /applet/local.
    const launchResult = await decideDevLaunchRoute(packageName, devUrlRes.value)
    if (launchResult.decision === "live") {
      replace("/applet/local", {
        packageName,
        devUrl: devUrlRes.value,
        appName: name,
        iconUrl,
      })
    }
    // else: stay put — the "Last reached" line stays accurate, user can
    // tap again or re-scan.
  }

  const onRescan = () => {
    push("/miniapps/settings/miniapp-developer-scanner")
  }

  const displayName = resolvedName ?? packageName ?? "Dev mini app"

  return (
    <Screen preset="fixed" ref={viewShotRef}>
      <View className="flex-1 items-center justify-center px-8 bg-background">
        {resolvedIconUrl ? (
          <SquircleView
            cornerSmoothing={100}
            preserveSmoothing={true}
            className="w-32 h-32 rounded-3xl overflow-hidden items-center justify-center mb-6">
            <Image
              source={resolvedIconUrl}
              style={{width: "100%", height: "100%"}}
              contentFit="cover"
              transition={200}
              cachePolicy="memory-disk"
            />
          </SquircleView>
        ) : null}

        <Text className="text-xl font-semibold text-foreground text-center" text={displayName} />
        <Text className="text-base text-foreground text-center mt-2" text="Dev server offline" />
        <Text
          className="text-sm text-muted-foreground text-center mt-1 mb-6"
          text={`Last reached: ${lastReachableLabel}`}
        />

        <View className="w-full max-w-[320px] gap-3">
          <Button text="Try again" onPress={onTryAgain} preset="alternate" />
          <Button text="Re-scan QR" onPress={onRescan} preset="default" />
        </View>
      </View>
    </Screen>
  )
}

function formatRelative(timestamp: number): string {
  const now = Date.now()
  const ms = now - timestamp
  if (ms < 60_000) return "just now"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`
  const days = Math.floor(ms / 86_400_000)
  return `${days} day${days === 1 ? "" : "s"} ago`
}
