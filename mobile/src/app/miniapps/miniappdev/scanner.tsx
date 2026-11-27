import {CameraView, useCameraPermissions} from "expo-camera"
import * as Haptics from "expo-haptics"
import {useEffect, useState} from "react"
import {ActivityIndicator, Linking, View} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import showAlert from "@/utils/AlertUtils"
import {engine} from "@mentra/engine"
import {installMiniappFromJsonUrl, normalizeManifestPermissions} from "@mentra/engine-host-internal"
import {startMiniappInstallFromLink} from "@/services/miniapps/miniappInstallFlow"
import {askPermissionsUI, checkPermissionsUI, PERMISSION_CONFIG} from "@/utils/PermissionsUtils"
import type {AppletInterface} from "@mentra/engine"

export default function MiniappDeveloperScannerScreen() {
  const {theme} = useAppTheme()
  const {goBack, clearHistoryAndGoHome} = useNavigationStore.getState()
  const [permission, requestPermission] = useCameraPermissions()
  const [scanned, setScanned] = useState(false)

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      requestPermission()
    }
  }, [permission, requestPermission])

  // An older CLI's release QR opens its miniapp only once each required permission its
  // miniapp.json declares is granted, the gate a home-tile tap applies. Asks for
  // the missing ones; after a denial, names them and offers Settings. Every way
  // out without opening runs onDecline, so the scanner never stays frozen.
  const grantRequiredPermissions = async (app: AppletInterface, onDecline: () => void): Promise<boolean> => {
    const result = await askPermissionsUI(app, theme)
    if (result === 1) return true
    if (result === 0) {
      const stillNeeded = await checkPermissionsUI(app)
      showAlert(
        translate("debugSettings:miniappScanPermissionsRequiredTitle"),
        translate("debugSettings:miniappScanPermissionsRequiredBody", {
          name: app.name,
          permissions: stillNeeded.map((p) => PERMISSION_CONFIG[p]?.name ?? p).join(", "),
        }),
        [
          {
            text: translate("debugSettings:miniappScanOpenSettings"),
            onPress: () => {
              onDecline()
              void Linking.openSettings()
            },
          },
          {text: translate("common:cancel"), onPress: onDecline, style: "cancel"},
        ],
      )
    } else {
      onDecline()
    }
    return false
  }

  // Open a freshly installed release the way a home-tile tap does, so the
  // developer lands in the miniapp instead of backing out of Settings to find it.
  const openInstalledRelease = async ({
    packageName,
    name,
    version,
  }: {
    packageName: string
    name: string
    version: string
  }) => {
    const showOnHomeScreen = () =>
      showAlert(
        translate("debugSettings:miniappScanInstalledTitle"),
        translate("debugSettings:miniappScanInstalledBody", {name, version}),
        [{text: "OK", onPress: () => goBack()}],
      )
    let leftScanner = false
    try {
      await engine.miniapps.refresh()
      const app = engine.miniapps.list().find((candidate) => candidate.packageName === packageName)
      if (!app) return showOnHomeScreen()
      // Normally a silent pass: the scan already granted what the release
      // server's manifest declared. Only an installed manifest that differs asks again.
      if (!(await grantRequiredPermissions(app, showOnHomeScreen))) {
        if (app.running) await engine.miniapps.stop(packageName)
        return
      }
      clearHistoryAndGoHome()
      leftScanner = true
      // Opening what they just scanned is the person's own choice.
      if (await engine.miniapps.start(app, {skipNavigation: true, trigger: "user"}))
        await engine.miniapps.setForeground(packageName)
    } catch (error) {
      console.warn(`Failed to open ${packageName} after installing it:`, error)
      if (!leftScanner) showOnHomeScreen()
    }
  }

  const handleBarcodeScanned = async ({data}: {data: string}) => {
    if (scanned) return
    setScanned(true)
    // Acknowledge the scan the instant it lands — a buzz the user feels before
    // any of the async manifest fetch / permission flow below runs. The camera
    // freezes (scanner is disabled while `scanned`) and the loading overlay
    // covers it, so without this the scan would feel like nothing happened.
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})

    if (data.startsWith("miniapp://release")) {
      try {
        const url = new URL(data)
        const baseUrl = decodeURIComponent(url.searchParams.get("url") || "")
        if (!baseUrl) throw new Error("release QR missing url param")

        // Check the release's own miniapp.json before installing. Installing over
        // a running copy restarts it, so a check after the install would let the
        // new release run without its permissions; stopping it first would lose
        // the installer's restore-on-failure.
        const manifestRes = await fetch(`${baseUrl.replace(/\/$/, "")}/miniapp.json`)
        if (!manifestRes.ok) throw new Error(`Failed to fetch miniapp.json: ${manifestRes.status}`)
        const manifest = (await manifestRes.json()) as Record<string, unknown>
        const releasePackage = typeof manifest.packageName === "string" ? manifest.packageName : ""
        const release = {
          packageName: releasePackage,
          name: typeof manifest.name === "string" ? manifest.name : releasePackage,
          permissions: normalizeManifestPermissions(
            manifest.permissions as Parameters<typeof normalizeManifestPermissions>[0],
          ),
        } as unknown as AppletInterface
        if (!(await grantRequiredPermissions(release, () => setScanned(false)))) return

        const res = await installMiniappFromJsonUrl(baseUrl)
        if (res.is_error()) {
          showAlert("Install failed", res.error.message ?? String(res.error), [
            {text: "OK", onPress: () => setScanned(false)},
          ])
          return
        }
        await openInstalledRelease(res.value)
      } catch (err) {
        showAlert("Install failed", String(err), [{text: "OK", onPress: () => setScanned(false)}])
      }
      return
    }

    // Everything else installs as any link does, through the install sheet: a miniapp's own URL, an open link, a
    // package link, and a local address (the URL `mentra dev` prints, or an older CLI's `miniapp://dev` code), which
    // installs as a development build.
    const outcome = await startMiniappInstallFromLink(data, "scanner")
    // Installed or opened, the flow has gone Home; otherwise the scanner resumes.
    if (outcome === "cancelled" || outcome === "failed") setScanned(false)
  }

  if (!permission) {
    return (
      <Screen preset="fixed">
        <Header
          title={translate("debugSettings:miniappScanTitle")}
          leftIcon="chevron-left"
          onLeftPress={() => goBack()}
        />
        <View className="flex-1 items-center justify-center">
          <Text className="text-[14px]" tx="debugSettings:miniappScanCheckingPermission" />
        </View>
      </Screen>
    )
  }

  if (!permission.granted) {
    return (
      <Screen preset="fixed">
        <Header
          title={translate("debugSettings:miniappScanTitle")}
          leftIcon="chevron-left"
          onLeftPress={() => goBack()}
        />
        <View className="flex-1 justify-center px-6">
          <View className="rounded-xl bg-white dark:bg-zinc-900 p-6 items-center gap-3">
            <Text className="text-lg font-semibold text-center" tx="debugSettings:miniappScanPermissionTitle" />
            <Text
              className="text-[13px] text-muted-foreground text-center mb-2 leading-[18px]"
              tx="debugSettings:miniappScanPermissionBody"
            />
            <Button
              tx={
                permission.canAskAgain
                  ? "debugSettings:miniappScanGrantAccess"
                  : "debugSettings:miniappScanOpenSettings"
              }
              onPress={async () => {
                if (permission.canAskAgain) {
                  await requestPermission()
                } else {
                  showAlert(
                    translate("debugSettings:miniappScanPermissionDeniedTitle"),
                    translate("debugSettings:miniappScanPermissionDeniedBody"),
                    [{text: "OK"}],
                  )
                }
              }}
              preset="alternate"
              flexContainer={false}
            />
          </View>
        </View>
      </Screen>
    )
  }

  return (
    <Screen preset="fixed">
      <Header
        title={translate("debugSettings:miniappScanTitle")}
        leftIcon="chevron-left"
        onLeftPress={() => goBack()}
      />

      <View className="px-4 pt-2 pb-4 gap-2">
        <Text className="text-base font-semibold" tx="debugSettings:miniappScanHeadline" />
        <Text className="text-[13px] leading-[18px] text-muted-foreground" tx="debugSettings:miniappScanBody" />
      </View>

      <View className="flex-1 mx-4 mt-4 mb-12 rounded-xl max-h-[420px] overflow-hidden bg-white">
        <CameraView
          style={{flex: 1}}
          barcodeScannerSettings={{barcodeTypes: ["qr"]}}
          onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
        />

        {!scanned && (
          <View className="absolute inset-0 items-center justify-center" pointerEvents="none">
            <View className="w-[240px] h-[240px] rounded-xl border-2 border-indigo-500" />
          </View>
        )}

        {!scanned && (
          <View className="absolute left-0 right-0 bottom-6 items-center" pointerEvents="none">
            <Text className="text-[13px] px-3 py-1.5 rounded-full overflow-hidden" tx="debugSettings:miniappScanHint" />
          </View>
        )}

        {/* Post-scan acknowledgement: dim the (now-frozen) camera and show a
            centered loading card while the manifest fetch / permission flow
            runs. This is the visual half of the scan feedback — the haptic in
            handleBarcodeScanned is the tactile half. No popup; it clears on its
            own when we navigate away, or when an error path resets `scanned`. */}
        {scanned && (
          <View className="absolute inset-0 items-center justify-center bg-black/50">
            <View className="flex-row items-center gap-3 rounded-2xl bg-white dark:bg-zinc-900 px-5 py-4">
              <ActivityIndicator color={theme.colors.tint} />
              <Text className="text-[15px] font-medium" tx="debugSettings:miniappScanLoading" />
            </View>
          </View>
        )}
      </View>
    </Screen>
  )
}
