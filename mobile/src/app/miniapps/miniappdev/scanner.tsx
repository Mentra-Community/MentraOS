import {CameraView, useCameraPermissions} from "expo-camera"
import * as Haptics from "expo-haptics"
import {useEffect, useState} from "react"
import {ActivityIndicator, Linking, View} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import showAlert from "@/utils/AlertUtils"
import {decideDevOpenRoute, engine} from "@mentra/engine"
import {appRegistry, registerDevApp, type DevAppRecord} from "@mentra/engine-host-internal"
import {askPermissionsUI, checkPermissionsUI, PERMISSION_CONFIG} from "@/utils/PermissionsUtils"
import {storage} from "@/utils/storage/storage"
import type {AppletInterface, AppletPermission} from "@mentra/engine"

export default function MiniappDeveloperScannerScreen() {
  const {theme} = useAppTheme()
  const {goBack, push, clearHistoryAndGoHome} = useNavigationStore.getState()
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

        const res = await appRegistry.installFromJsonUrl(baseUrl)
        if (res.is_error()) {
          showAlert("Install failed", res.error.message ?? String(res.error), [
            {text: "OK", onPress: () => setScanned(false)},
          ])
          return
        }
        showAlert("Installed", `${res.value.name} v${res.value.version} is on your home screen.`, [
          {text: "OK", onPress: () => goBack()},
        ])
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
      let mdnsHost: string | undefined
      let devAttestation: string | undefined

      if (data.startsWith("miniapp://dev")) {
        const url = new URL(data)
        devUrl = decodeURIComponent(url.searchParams.get("url") || "")
        name = url.searchParams.get("name") || undefined
        packageName = url.searchParams.get("package") || undefined
        devPort = url.searchParams.get("dev") || undefined
        mdnsHost = url.searchParams.get("mdns") || undefined
        devAttestation = url.searchParams.get("attestation") || undefined
      } else if (data.startsWith("http://") || data.startsWith("https://")) {
        devUrl = data
      } else {
        showAlert(
          translate("debugSettings:miniappScanInvalidQrTitle"),
          translate("debugSettings:miniappScanInvalidQrBody"),
          [{text: "OK", onPress: () => setScanned(false)}],
        )
        return
      }

      if (!devUrl) {
        showAlert(
          translate("debugSettings:miniappScanInvalidQrTitle"),
          translate("debugSettings:miniappScanInvalidQrNoUrl"),
          [{text: "OK", onPress: () => setScanned(false)}],
        )
        return
      }

      // Pass mDNS up front — storage hasn't been written yet on first scan, so
      // decideDevOpenRoute can't read `_dev_mdns` until we persist below.
      const launchResult = await decideDevOpenRoute(packageName ?? "", devUrl, {
        alternateHosts: mdnsHost ? [mdnsHost] : undefined,
      })

      const manifest = launchResult.decision === "live" ? launchResult.manifest : null
      // Keep an explicit identity separate from the offline-screen display
      // fallback — never persist routing keys under the shared `com.dev.unknown`.
      const knownPackageName = (manifest?.packageName || packageName)?.trim() || undefined
      packageName = knownPackageName || "com.dev.unknown"
      name = manifest?.name || name || "Dev Miniapp"
      const iconPath = manifest?.icon as string | undefined
      const manifestPermissions: AppletPermission[] = Array.isArray(manifest?.permissions)
        ? (manifest!.permissions as AppletPermission[])
        : []

      const resolvedBase = (
        (launchResult.decision === "live" ? launchResult.resolvedUrl : undefined) || devUrl
      ).replace(/\/$/, "")
      let iconUrl: string | undefined
      if (iconPath) {
        iconUrl = /^https?:\/\//.test(iconPath)
          ? iconPath
          : `${resolvedBase}/${iconPath.replace(/^\//, "")}`
      }

      const portNum = devPort ? parseInt(devPort, 10) : NaN

      // Persist a package-keyed home tile and routing record so this dev
      // miniapp remains independently launchable without rescanning. Its icon
      // is copied locally while the server is reachable.
      if (manifest && knownPackageName) {
        const existing = engine.miniapps.list().find((app) => app.packageName === knownPackageName)
        if (existing?.running) await engine.miniapps.stop(knownPackageName)
        await registerDevApp({
          packageName: knownPackageName,
          name: name ?? knownPackageName,
          iconUrl: iconUrl ?? `${resolvedBase}/icon.png`,
          // Prefer the host that actually answered (may be mDNS / Metro failover).
          devUrl: resolvedBase,
          // Explicit empty clears a prior QR's sidecar port / mDNS for this package.
          devPort: Number.isFinite(portNum) ? portNum : undefined,
          mdnsHost: mdnsHost ?? "",
          devAttestation,
          type: manifest.type as DevAppRecord["type"],
          permissions: manifest.permissions as DevAppRecord["permissions"],
          hardwareRequirements: manifest.hardwareRequirements as DevAppRecord["hardwareRequirements"],
          actions: manifest.actions as DevAppRecord["actions"],
        })
      } else if (knownPackageName) {
        // Reachability failed — still stash URL + mDNS so "Try again" can recover
        // after a laptop Wi-Fi IP change without forcing a re-scan. Only when the
        // QR (or a prior identity) named a real package — never `com.dev.unknown`.
        storage.save(`${knownPackageName}_dev_url`, devUrl)
        if (mdnsHost) {
          storage.save(`${knownPackageName}_dev_mdns`, mdnsHost)
        } else {
          storage.remove(`${knownPackageName}_dev_mdns`)
        }
        if (Number.isFinite(portNum)) {
          storage.save(`${knownPackageName}_dev_port`, portNum)
        } else {
          storage.remove(`${knownPackageName}_dev_port`)
        }
        // Keep the QR attestation so offline "Try again" can register with the
        // same auto-auth proof the live scanner path would have used.
        if (devAttestation) {
          storage.save(`${knownPackageName}_dev_attestation`, devAttestation)
        } else {
          storage.remove(`${knownPackageName}_dev_attestation`)
        }
      }

      if (launchResult.decision === "offline") {
        clearHistoryAndGoHome()
        push("/applet/dev-offline", {packageName, name, iconUrl})
        return
      }

      if (launchResult.decision === "cached") {
        clearHistoryAndGoHome()
        await engine.miniapps.refresh()
        await engine.miniapps.setForeground(packageName)
        return
      }

      const fakeApplet = {
        packageName: packageName ?? "",
        name: name ?? "",
        permissions: manifestPermissions,
      } as unknown as AppletInterface
      const permResult = await askPermissionsUI(fakeApplet, theme)
      if (permResult === -1) {
        setScanned(false)
        return
      }
      if (permResult === 0) {
        const stillNeeded = await checkPermissionsUI(fakeApplet)
        const friendlyNames = stillNeeded.map((p) => PERMISSION_CONFIG[p]?.name ?? p).join(", ")
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

      clearHistoryAndGoHome()
      await engine.miniapps.refresh()
      await engine.miniapps.setForeground(packageName)
    } catch (error) {
      showAlert("Error", String(error), [{text: "OK", onPress: () => setScanned(false)}])
    }
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
