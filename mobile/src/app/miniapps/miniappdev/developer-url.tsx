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
import {decideDevLaunchRoute} from "@mentra/island"
import {askPermissionsUI, checkPermissionsUI, PERMISSION_CONFIG} from "@/utils/PermissionsUtils"
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

    const manifestPermissions: AppletPermission[] = Array.isArray(launchResult.manifest.permissions)
      ? (launchResult.manifest.permissions as AppletPermission[])
      : []

    if (manifestPermissions.length > 0) {
      const fakeApplet = {
        packageName: entry.packageName,
        name: entry.name,
        permissions: manifestPermissions,
      } as unknown as AppletInterface
      const permResult = await askPermissionsUI(fakeApplet, theme)
      if (permResult === -1) return
      if (permResult === 0) {
        const stillNeeded = await checkPermissionsUI(fakeApplet)
        const friendlyNames = stillNeeded.map((p) => PERMISSION_CONFIG[p]?.name ?? p).join(", ")
        showAlert(
          "Required permissions denied",
          `${entry.name} can't run without these permissions: ${friendlyNames}. Open Settings to enable them, then try again.`,
          [
            {text: "Open Settings", onPress: () => Linking.openSettings()},
            {text: "Cancel", style: "cancel"},
          ],
        )
        return
      }
    }

    push("/applet/local", {
      packageName: entry.packageName,
      devUrl: entry.url,
      appName: entry.name,
      iconUrl: entry.iconUrl,
    })
  }

  const handleLoadUrl = async () => {
    const trimmed = url.trim().replace(/\/+$/, "")
    if (!trimmed) {
      showAlert(translate("devSettings:miniappUrlEmptyTitle"), translate("devSettings:miniappUrlEmptyBody"), [
        {text: "OK"},
      ])
      return
    }
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      showAlert(translate("devSettings:miniappUrlInvalidTitle"), translate("devSettings:miniappUrlInvalidBody"), [
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
          translate("devSettings:miniappUrlFetchErrorTitle"),
          translate("devSettings:miniappUrlFetchErrorBody", {url: trimmed}),
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
      // Persist the dev URL keyed on packageName so Composer's
      // getLocalApplets sees it and so home-tile taps after a phone
      // restart can route to the live server.
      storage.save(`${entry.packageName}_dev_url`, entry.url)

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
      <Header title={translate("devSettings:miniappUrlTitle")} leftIcon="chevron-left" onLeftPress={() => goBack()} />

      <ScrollView className="flex px-6 -mx-6">
        <View className="flex gap-6">
          <Group title={translate("devSettings:miniappUrlGroupTitle")}>
            <GlassView className="bg-primary-foreground rounded-2xl px-4 py-4 gap-2">
              <Text className="text-base text-text" tx="devSettings:miniappUrlLabel" />
              <Text className="text-xs text-textDim flex-row flex-wrap">
                {translate("devSettings:miniappUrlSubtitlePrefix")}
                <Text className="font-mono text-text" text="/miniapp.json" />
                {translate("devSettings:miniappUrlSubtitleSuffix")}
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
                tx={loading ? "devSettings:miniappUrlLoadingButton" : "devSettings:miniappUrlLoadButton"}
                onPress={handleLoadUrl}
                disabled={loading}
                preset="alternate"
                flexContainer={false}
              />
            </GlassView>
          </Group>

          {recent.length > 0 && (
            <Group title={translate("devSettings:miniappUrlRecentTitle")}>
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
