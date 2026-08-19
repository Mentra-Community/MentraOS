import {CameraView, useCameraPermissions} from "expo-camera"
import * as Haptics from "expo-haptics"
import {useEffect, useState, useSyncExternalStore, type ReactNode} from "react"
import {Linking, Modal, Text as RNText, View} from "react-native"

import {engine} from "@mentra/engine"
import {Button, Header, Screen, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {completeQrScan, getQrScanRequest, requestPhoneQrScan, subscribeQrScan} from "@/services/qrScanRequest"
import showAlert from "@/utils/AlertUtils"

function useQrScanRequest() {
  return useSyncExternalStore(subscribeQrScan, getQrScanRequest, getQrScanRequest)
}

/**
 * Phone-camera QR scanner presented as a Modal over the still-mounted miniapp
 * WebView. Do not navigate or clearForeground from here — that fires UI_CLOSE.
 */
export function QrScanOverlay() {
  const request = useQrScanRequest()
  const {theme} = useAppTheme()
  const [permission, requestPermission] = useCameraPermissions()
  const [scanned, setScanned] = useState(false)

  useEffect(() => {
    if (typeof engine.updateUiSeams === "function") {
      engine.updateUiSeams({scanQr: requestPhoneQrScan})
    }
  }, [])

  useEffect(() => {
    setScanned(false)
    if (request && permission && !permission.granted && permission.canAskAgain) {
      void requestPermission()
    }
  }, [request?.id, permission, requestPermission])

  if (!request) return null

  const cancel = () => completeQrScan({cancelled: true})
  const title = request.options.title?.trim() || translate("qrScan:defaultTitle")
  const hint = request.options.hint?.trim() || translate("qrScan:defaultHint")

  const onScanned = ({data}: {data: string}) => {
    if (scanned) return
    setScanned(true)
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {})
    completeQrScan({data})
  }

  let body: ReactNode
  if (!permission) {
    body = (
      <View className="flex-1 items-center justify-center">
        <Text className="text-[14px]" tx="qrScan:checkingPermission" />
      </View>
    )
  } else if (!permission.granted) {
    body = (
      <View className="flex-1 justify-center px-6">
        <View className="rounded-xl bg-white dark:bg-zinc-900 p-6 items-center gap-3">
          <Text className="text-lg font-semibold text-center" tx="qrScan:permissionTitle" />
          <Text
            className="text-[13px] text-muted-foreground text-center mb-2 leading-[18px]"
            tx="qrScan:permissionBody"
          />
          <Button
            tx={permission.canAskAgain ? "qrScan:grantAccess" : "qrScan:openSettings"}
            onPress={async () => {
              if (permission.canAskAgain) {
                await requestPermission()
                return
              }
              try {
                await Linking.openSettings()
              } catch {
                showAlert(translate("qrScan:permissionDeniedTitle"), translate("qrScan:permissionDeniedBody"), [
                  {text: "OK"},
                ])
              }
            }}
            preset="alternate"
            flexContainer={false}
          />
        </View>
      </View>
    )
  } else {
    body = (
      <View className="flex-1 mx-4 mt-4 mb-12 rounded-xl max-h-[420px] overflow-hidden bg-white">
        <CameraView
          style={{flex: 1}}
          facing="back"
          barcodeScannerSettings={{barcodeTypes: ["qr"]}}
          onBarcodeScanned={scanned ? undefined : onScanned}
        />
        {!scanned && (
          <View className="absolute inset-0 items-center justify-center" pointerEvents="none">
            <View className="w-[240px] h-[240px] rounded-xl border-2 border-indigo-500" />
          </View>
        )}
        {!scanned && (
          <View className="absolute left-0 right-0 bottom-6 items-center" pointerEvents="none">
            <RNText className="text-[13px] px-3 py-1.5 rounded-full overflow-hidden text-white bg-black/50">
              {hint}
            </RNText>
          </View>
        )}
      </View>
    )
  }

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={cancel}>
      <Screen preset="fixed" backgroundColor={theme.colors.background}>
        <Header title={title} leftIcon="chevron-left" onLeftPress={cancel} />
        {body}
      </Screen>
    </Modal>
  )
}
