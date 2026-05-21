import {CameraView, useCameraPermissions} from "expo-camera"
import * as Haptics from "expo-haptics"
import {useEffect, useState} from "react"
import {Linking, View} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import showAlert from "@/utils/AlertUtils"
import {appRegistry, decideDevLaunchRoute} from "@mentra/island"
import {askPermissionsUI, checkPermissionsUI, PERMISSION_CONFIG} from "@/utils/PermissionsUtils"
import {storage} from "@/utils/storage/storage"
import type {AppletInterface, AppletPermission} from "@/../../cloud/packages/types/src"

export default function MiniappDeveloperScannerScreen() {
  const {theme} = useAppTheme()
  const {goBack, replace, push, clearHistoryAndGoHome} = useNavigationStore.getState()
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

    if (data.startsWith("mentra-miniapp://release")) {
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
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
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

      if (data.startsWith("mentra-miniapp://dev")) {
        const url = new URL(data)
        devUrl = decodeURIComponent(url.searchParams.get("url") || "")
        name = url.searchParams.get("name") || undefined
        packageName = url.searchParams.get("package") || undefined
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

      const launchResult = await decideDevLaunchRoute(packageName ?? "", devUrl)

      const manifest = launchResult.manifest
      packageName = packageName || manifest?.packageName || "com.dev.unknown"
      name = name || manifest?.name || "Dev Miniapp"
      const iconPath = manifest?.icon as string | undefined
      const manifestPermissions: AppletPermission[] = Array.isArray(manifest?.permissions)
        ? (manifest!.permissions as AppletPermission[])
        : []

      let iconUrl: string | undefined
      if (iconPath) {
        iconUrl = /^https?:\/\//.test(iconPath)
          ? iconPath
          : `${devUrl.replace(/\/$/, "")}/${iconPath.replace(/^\//, "")}`
      }

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

      if (launchResult.decision === "offline") {
        clearHistoryAndGoHome()
        push("/applet/dev-offline", {packageName, name, iconUrl})
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
      push("/applet/local", {
        packageName,
        devUrl,
        appName: name,
        iconUrl,
        ...(devPort ? {devPort} : {}),
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
        <View className="flex-1 items-center justify-center">
          <Text className="text-[14px]" tx="devSettings:miniappScanCheckingPermission" />
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
        <View className="flex-1 justify-center px-6">
          <View className="rounded-xl bg-white dark:bg-zinc-900 p-6 items-center gap-3">
            <Text
              className="text-lg font-semibold text-center"
              tx="devSettings:miniappScanPermissionTitle"
            />
            <Text
              className="text-[13px] text-muted-foreground text-center mb-2 leading-[18px]"
              tx="devSettings:miniappScanPermissionBody"
            />
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

      <View className="px-4 pt-2 pb-4 gap-2">
        <Text className="text-base font-semibold" tx="devSettings:miniappScanHeadline" />
        <Text
          className="text-[13px] leading-[18px] text-muted-foreground"
          tx="devSettings:miniappScanBody"
        />
      </View>

      <View className="flex-1 mx-4 mt-4 mb-12 rounded-xl max-h-[420px] overflow-hidden bg-white">
        <CameraView
          style={{flex: 1}}
          barcodeScannerSettings={{barcodeTypes: ["qr"]}}
          onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
        />

        <View className="absolute inset-0 items-center justify-center" pointerEvents="none">
          <View className="w-[240px] h-[240px] rounded-xl border-2 border-indigo-500" />
        </View>

        <View className="absolute left-0 right-0 bottom-6 items-center" pointerEvents="none">
          <Text
            className="text-[13px] px-3 py-1.5 rounded-full overflow-hidden"
            tx="devSettings:miniappScanHint"
          />
        </View>
      </View>
    </Screen>
  )
}
