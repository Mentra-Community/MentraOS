import {CameraView, useCameraPermissions} from "expo-camera"
import * as Haptics from "expo-haptics"
import {useEffect, useState} from "react"
import {Linking, StyleSheet, TextStyle, View, ViewStyle} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import {installMiniappFromUrl} from "@/services/miniapp/installFromUrl"
import {decideDevLaunchRoute} from "@/utils/devMiniappLaunch"
import {askPermissionsUI, checkPermissionsUI, PERMISSION_CONFIG} from "@/utils/PermissionsUtils"
import {storage} from "@/utils/storage/storage"
import type {AppletInterface, AppletPermission} from "@/../../cloud/packages/types/src"

export default function MiniappDeveloperScannerScreen() {
  const {theme, themed} = useAppTheme()
  const {goBack, replace} = useNavigationHistory()
  const [permission, requestPermission] = useCameraPermissions()
  const [scanned, setScanned] = useState(false)

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) {
      requestPermission()
    }
  }, [permission, requestPermission])

  const handleBarcodeScanned = async ({data}: {data: string}) => {
    if (scanned) return
    setScanned(true)

    // Release QR (`mentra-miniapp release` from the CLI). Different from
    // the dev scheme: this downloads a packaged .zip onto the phone and
    // registers it as a first-class installed local miniapp. The miniapp
    // runs offline forever; no laptop/dev-server dependency after install.
    if (data.startsWith("mentra-miniapp://release")) {
      try {
        const url = new URL(data)
        const baseUrl = decodeURIComponent(url.searchParams.get("url") || "")
        if (!baseUrl) throw new Error("release QR missing url param")

        const res = await installMiniappFromUrl(baseUrl)
        if (res.is_error()) {
          showAlert("Install failed", res.error.message ?? String(res.error), [
            {text: "OK", onPress: () => setScanned(false)},
          ])
          return
        }
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
        showAlert(
          "Installed",
          `${res.value.name} v${res.value.version} is on your home screen.`,
          [{text: "OK", onPress: () => goBack()}],
        )
      } catch (err) {
        showAlert("Install failed", String(err), [{text: "OK", onPress: () => setScanned(false)}])
      }
      return
    }

    try {
      let devUrl: string
      let packageName: string | undefined
      let name: string | undefined
      let devPort: string | undefined

      if (data.startsWith("mentra-miniapp://dev")) {
        const url = new URL(data)
        devUrl = decodeURIComponent(url.searchParams.get("url") || "")
        name = url.searchParams.get("name") || undefined
        packageName = url.searchParams.get("package") || undefined
        // Optional sidecar port for live reload + console bridge. Older CLI
        // versions don't include this — phone falls back to no live reload.
        devPort = url.searchParams.get("dev") || undefined
      } else if (data.startsWith("http://") || data.startsWith("https://")) {
        devUrl = data
      } else {
        showAlert(
          translate("devSettings:miniappScanInvalidQrTitle"),
          translate("devSettings:miniappScanInvalidQrBody"),
          [{text: "OK", onPress: () => setScanned(false)}],
        )
        return
      }

      if (!devUrl) {
        showAlert(
          translate("devSettings:miniappScanInvalidQrTitle"),
          translate("devSettings:miniappScanInvalidQrNoUrl"),
          [{text: "OK", onPress: () => setScanned(false)}],
        )
        return
      }

      // One round trip: fetches manifest AND decides reachability. Avoids
      // the previous double-fetch (one for permissions/name, one for the
      // reachability HEAD).
      const launchResult = await decideDevLaunchRoute(packageName ?? "", devUrl)

      // Pull packageName / name / icon / permissions from the manifest if
      // we got one. QR-string params take precedence over manifest fields.
      const manifest = launchResult.manifest
      packageName = packageName || manifest?.packageName || "com.dev.unknown"
      name = name || manifest?.name || "Dev Miniapp"
      const iconPath = manifest?.icon as string | undefined
      const manifestPermissions: AppletPermission[] = Array.isArray(manifest?.permissions)
        ? (manifest!.permissions as AppletPermission[])
        : []

      // Resolve the icon to an absolute URL on the dev server. Supports either
      // a relative path ("icon.png") or an absolute URL.
      let iconUrl: string | undefined
      if (iconPath) {
        iconUrl = /^https?:\/\//.test(iconPath)
          ? iconPath
          : `${devUrl.replace(/\/$/, "")}/${iconPath.replace(/^\//, "")}`
      }

      // Persist the dev URL keyed on packageName so a relaunched MentraOS
      // can route the home-tile tap back to the live server. Composer's
      // getLocalApplets reads this key when populating the applet store.
      if (packageName) {
        storage.save(`${packageName}_dev_url`, devUrl)
        if (devPort) {
          const portNum = parseInt(devPort, 10)
          if (Number.isFinite(portNum)) {
            storage.save(`${packageName}_dev_port`, portNum)
          }
        }
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})

      // If the dev server didn't respond, route directly to the offline
      // takeover. We have nothing to gate against (no manifest = no
      // permissions list) and the live mount would fail anyway.
      if (launchResult.decision === "offline") {
        replace("/applet/dev-offline", {packageName, name, iconUrl})
        return
      }

      // Gate launch on OS permissions declared in the miniapp's manifest.
      // The home-tile path runs the same gate; without this, the very first
      // launch (right after scanning) skips it and the miniapp opens in a
      // broken state — events from un-granted OS permissions silently never
      // arrive.
      const fakeApplet = {
        packageName: packageName ?? "",
        name: name ?? "",
        permissions: manifestPermissions,
      } as unknown as AppletInterface
      const permResult = await askPermissionsUI(fakeApplet, theme)
      if (permResult === -1) {
        // User cancelled, or Android READ_NOTIFICATIONS flow is in progress.
        // Re-arm scanner; the home tile is registered so they can launch
        // again from there once the OS dance is complete.
        setScanned(false)
        return
      }
      if (permResult === 0) {
        // User tried, but at least one *required* OS permission is still
        // denied. Tell them why we're not launching and offer Settings.
        const stillNeeded = await checkPermissionsUI(fakeApplet)
        const friendlyNames = stillNeeded
          .map((p) => PERMISSION_CONFIG[p]?.name ?? p)
          .join(", ")
        showAlert(
          "Required permissions denied",
          `${name} can't run without these permissions: ${friendlyNames}. Open Settings to enable them, then try again.`,
          [
            {text: "Open Settings", onPress: () => Linking.openSettings()},
            {text: "Cancel", onPress: () => setScanned(false), style: "cancel"},
          ],
        )
        return
      }

      replace("/applet/local", {
        packageName,
        devUrl,
        appName: name,
        iconUrl,
        ...(devPort ? {devPort} : {}),
        ...(manifest ? {manifestJson: JSON.stringify(manifest)} : {}),
      })
    } catch (error) {
      showAlert("Error", String(error), [{text: "OK", onPress: () => setScanned(false)}])
    }
  }

  if (!permission) {
    return (
      <Screen preset="fixed">
        <Header
          title={translate("devSettings:miniappScanTitle")}
          leftIcon="chevron-left"
          onLeftPress={() => goBack()}
        />
        <View style={themed($centered)}>
          <Text style={themed($muted)} tx="devSettings:miniappScanCheckingPermission" />
        </View>
      </Screen>
    )
  }

  if (!permission.granted) {
    return (
      <Screen preset="fixed">
        <Header
          title={translate("devSettings:miniappScanTitle")}
          leftIcon="chevron-left"
          onLeftPress={() => goBack()}
        />
        <View style={themed($permissionContainer)}>
          <View style={themed($permissionCard)}>
            <Text style={themed($permissionTitle)} tx="devSettings:miniappScanPermissionTitle" />
            <Text style={themed($permissionBody)} tx="devSettings:miniappScanPermissionBody" />
            <Button
              tx={permission.canAskAgain ? "devSettings:miniappScanGrantAccess" : "devSettings:miniappScanOpenSettings"}
              onPress={async () => {
                if (permission.canAskAgain) {
                  await requestPermission()
                } else {
                  showAlert(
                    translate("devSettings:miniappScanPermissionDeniedTitle"),
                    translate("devSettings:miniappScanPermissionDeniedBody"),
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
      <Header title={translate("devSettings:miniappScanTitle")} leftIcon="chevron-left" onLeftPress={() => goBack()} />

      <View style={themed($instructions)}>
        <Text style={themed($instructionsHeadline)} tx="devSettings:miniappScanHeadline" />
        <Text style={themed($instructionsBody)} tx="devSettings:miniappScanBody" />
      </View>

      <View style={themed($cameraContainer)}>
        <CameraView
          style={themed($camera)}
          barcodeScannerSettings={{barcodeTypes: ["qr"]}}
          onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
        />

        <View style={themed($overlay)} pointerEvents="none">
          <View style={themed($reticle)} />
        </View>

        <View style={themed($hintContainer)} pointerEvents="none">
          <Text style={themed($hintText)} tx="devSettings:miniappScanHint" />
        </View>
      </View>
    </Screen>
  )
}

const $centered: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
})

const $muted: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textDim,
  fontSize: 14,
})

const $permissionContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flex: 1,
  padding: spacing.s6,
  justifyContent: "center",
})

const $permissionCard: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s4,
  padding: spacing.s6,
  alignItems: "center",
  gap: spacing.s3,
})

const $permissionTitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 18,
  fontWeight: "600",
  color: colors.text,
  textAlign: "center",
})

const $permissionBody: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 13,
  color: colors.textDim,
  textAlign: "center",
  marginBottom: spacing.s2,
  lineHeight: 18,
})

const $instructions: ThemedStyle<ViewStyle> = ({spacing}) => ({
  paddingHorizontal: spacing.s6,
  paddingTop: spacing.s2,
  paddingBottom: spacing.s4,
  gap: spacing.s2,
})

const $instructionsHeadline: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  fontWeight: "600",
  color: colors.text,
})

const $instructionsBody: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 13,
  lineHeight: 18,
  color: colors.textDim,
})

const $cameraContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flex: 1,
  marginHorizontal: spacing.s4,
  marginTop: spacing.s4,
  marginBottom: spacing.s12,
  maxHeight: 420,
  borderRadius: spacing.s4,
  overflow: "hidden",
  backgroundColor: colors.background,
})

const $camera: ThemedStyle<ViewStyle> = () => ({
  flex: 1,
})

const $overlay: ThemedStyle<ViewStyle> = () => ({
  ...StyleSheet.absoluteFillObject,
  alignItems: "center",
  justifyContent: "center",
})

const $reticle: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  width: 240,
  height: 240,
  borderRadius: spacing.s4,
  borderWidth: 2,
  borderColor: colors.primary,
})

const $hintContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  position: "absolute",
  bottom: spacing.s6,
  left: 0,
  right: 0,
  alignItems: "center",
})

const $hintText: ThemedStyle<TextStyle> = () => ({
  color: "#fff",
  fontSize: 13,
  backgroundColor: "rgba(0,0,0,0.55)",
  paddingHorizontal: 12,
  paddingVertical: 6,
  borderRadius: 999,
  overflow: "hidden",
})
