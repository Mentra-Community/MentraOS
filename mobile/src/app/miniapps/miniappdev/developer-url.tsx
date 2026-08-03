import {useEffect, useState} from "react"
import {Linking, ScrollView, TextInput, View} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import GlassView from "@/components/ui/GlassView"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {Spacer} from "@/components/ui/Spacer"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import showAlert from "@/utils/AlertUtils"
import {decideDevLaunchRoute, engine} from "@mentra/engine"
import {registerDevApp, type DevAppRecord} from "@mentra/engine/internal"
import {askPermissionsUI, checkPermissionsUI, PERMISSION_CONFIG} from "@/utils/PermissionsUtils"
import {markMiniappDevMode} from "@/utils/miniappDevMode"
import {storage} from "@/utils/storage/storage"
import type {AppletInterface, AppletPermission} from "@/../../cloud/packages/types/src"

const RECENT_KEY = "miniapp_dev_recent"
const MAX_RECENT = 5

interface RecentDevApp {
  packageName: string
  name: string
  url: string
  /** Resolved absolute icon URL (if the manifest declared one). Persisted
   *  so re-launching from the recent list doesn't show a placeholder. */
  iconUrl?: string
  timestamp: number
}

/** Resolve a manifest's icon path (relative or absolute) against a base URL. */
function resolveIconUrl(baseUrl: string, iconPath: string | undefined): string | undefined {
  if (!iconPath) return undefined
  if (/^https?:\/\//.test(iconPath)) return iconPath
  return `${baseUrl.replace(/\/$/, "")}/${iconPath.replace(/^\//, "")}`
}

/**
 * Derive the dev sidecar port from a `mentra-miniapp dev` user-server URL. The
 * CLI starts the static user server on `port` and the bundle/live-reload sidecar
 * on `port + 1`, so the sidecar is the URL's port plus one. Returns undefined if
 * the URL has no explicit port (nothing to derive a sidecar from).
 */
function deriveDevPort(url: string): number | undefined {
  try {
    const port = Number(new URL(url).port)
    return Number.isFinite(port) && port > 0 ? port + 1 : undefined
  } catch {
    return undefined
  }
}

export default function MiniappDeveloperUrlScreen() {
  const {theme} = useAppTheme()
  const {goBack, push} = useNavigationStore.getState()
  const [url, setUrl] = useState("")
  const [loading, setLoading] = useState(false)
  const [recent, setRecent] = useState<RecentDevApp[]>([])

  useEffect(() => {
    const result = storage.load<RecentDevApp[]>(RECENT_KEY)
    if (result.is_ok()) setRecent(result.value)
  }, [])

  const saveRecent = (items: RecentDevApp[]) => {
    setRecent(items)
    storage.save(RECENT_KEY, items)
  }

  const launchDevMiniapp = async (entry: RecentDevApp) => {
    // One round trip: reachability + manifest. Avoids a second fetch
    // for the permission-gate input.
    const launchResult = await decideDevLaunchRoute(entry.packageName, entry.url)

    if (launchResult.decision === "offline") {
      push("/applet/dev-offline", {
        packageName: entry.packageName,
        name: entry.name,
      })
      return
    }

    // Single chokepoint for both entry paths (typed URL + recent-list tap): a
    // reachable dev server means a real dev app loaded, so latch the per-account
    // "this user is a developer" signal here (idempotent). Marking after the
    // offline check keeps a failed/unreachable launch from flipping the flag.
    markMiniappDevMode()

    const packageName = launchResult.manifest.packageName || entry.packageName
    const appName = launchResult.manifest.name || entry.name
    const manifestPermissions: AppletPermission[] = Array.isArray(launchResult.manifest.permissions)
      ? (launchResult.manifest.permissions as AppletPermission[])
      : []

    if (manifestPermissions.length > 0) {
      const fakeApplet = {
        packageName,
        name: appName,
        permissions: manifestPermissions,
      } as unknown as AppletInterface
      const permResult = await askPermissionsUI(fakeApplet, theme)
      if (permResult === -1) return
      if (permResult === 0) {
        const stillNeeded = await checkPermissionsUI(fakeApplet)
        const friendlyNames = stillNeeded.map((p) => PERMISSION_CONFIG[p]?.name ?? p).join(", ")
        showAlert(
          "Required permissions denied",
          `${appName} can't run without these permissions: ${friendlyNames}. Open Settings to enable them, then try again.`,
          [
            {text: "Open Settings", onPress: () => Linking.openSettings()},
            {text: "Cancel", style: "cancel"},
          ],
        )
        return
      }
    }

    // Refresh this package's manifest metadata before foregrounding it. Other
    // dev packages remain registered and independently launchable.
    const existing = engine.miniapps.list().find((app) => app.packageName === packageName)
    if (existing?.running) await engine.miniapps.stop(packageName)
    await registerDevApp({
      packageName,
      name: appName,
      iconUrl: resolveIconUrl(entry.url, launchResult.manifest.icon) ?? entry.iconUrl ?? `${entry.url}/icon.png`,
      devUrl: entry.url,
      devPort: deriveDevPort(entry.url),
      type: launchResult.manifest.type as DevAppRecord["type"],
      permissions: launchResult.manifest.permissions as DevAppRecord["permissions"],
      hardwareRequirements: launchResult.manifest.hardwareRequirements as DevAppRecord["hardwareRequirements"],
      actions: launchResult.manifest.actions as DevAppRecord["actions"],
    })

    await engine.miniapps.refresh()
    await engine.miniapps.setForeground(packageName)
  }

  const handleLoadUrl = async () => {
    const trimmed = url.trim().replace(/\/+$/, "")
    if (!trimmed) {
      showAlert(translate("debugSettings:miniappUrlEmptyTitle"), translate("debugSettings:miniappUrlEmptyBody"), [
        {text: "OK"},
      ])
      return
    }
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      showAlert(translate("debugSettings:miniappUrlInvalidTitle"), translate("debugSettings:miniappUrlInvalidBody"), [
        {text: "OK"},
      ])
      return
    }

    setLoading(true)
    try {
      // Single fetch; serves as both validation that the URL points at a
      // real miniapp dev server AND the manifest source for the launch.
      const launchResult = await decideDevLaunchRoute("", trimmed)
      if (launchResult.decision === "offline") {
        showAlert(
          translate("debugSettings:miniappUrlFetchErrorTitle"),
          translate("debugSettings:miniappUrlFetchErrorBody", {url: trimmed}),
          [{text: "OK"}],
        )
        return
      }

      const manifest = launchResult.manifest
      const entry: RecentDevApp = {
        packageName: manifest.packageName || "com.dev.unknown",
        name: manifest.name || "Dev Mini App",
        url: trimmed,
        iconUrl: resolveIconUrl(trimmed, manifest.icon),
        timestamp: Date.now(),
      }
      const updated = [entry, ...recent.filter((r) => r.url !== entry.url)].slice(0, MAX_RECENT)
      saveRecent(updated)

      // launchDevMiniapp re-runs the reachability + manifest fetch (cheap;
      // catches manifest changes between save and tap) and runs the
      // permission gate before navigating.
      await launchDevMiniapp(entry)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Screen preset="fixed">
      <Header title={translate("debugSettings:miniappUrlTitle")} leftIcon="chevron-left" onLeftPress={() => goBack()} />

      <ScrollView className="flex px-6 -mx-6">
        <View className="flex gap-6">
          <Group title={translate("debugSettings:miniappUrlGroupTitle")}>
            <GlassView className="bg-primary-foreground rounded-2xl px-4 py-4 gap-2">
              <Text className="text-base text-text" tx="debugSettings:miniappUrlLabel" />
              <Text className="text-xs text-textDim flex-row flex-wrap">
                {translate("debugSettings:miniappUrlSubtitlePrefix")}
                <Text className="font-mono text-text" text="/miniapp.json" />
                {translate("debugSettings:miniappUrlSubtitleSuffix")}
              </Text>
              <TextInput
                className="bg-background border border-primary rounded-lg px-3 py-2 text-sm mt-1 mb-1 text-text"
                placeholder="http://192.168.1.50:3000"
                placeholderTextColor={theme.colors.textDim}
                value={url}
                onChangeText={setUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                editable={!loading}
              />
              <Button
                tx={loading ? "debugSettings:miniappUrlLoadingButton" : "debugSettings:miniappUrlLoadButton"}
                onPress={handleLoadUrl}
                disabled={loading}
                preset="alternate"
                flexContainer={false}
              />
            </GlassView>
          </Group>

          {recent.length > 0 && (
            <Group title={translate("debugSettings:miniappUrlRecentTitle")}>
              {recent.map((item) => (
                <RouteButton
                  key={item.url}
                  label={item.name}
                  subtitle={item.url}
                  onPress={() => launchDevMiniapp(item)}
                />
              ))}
            </Group>
          )}

          <Spacer height={theme.spacing.s12} />
        </View>
      </ScrollView>
    </Screen>
  )
}
