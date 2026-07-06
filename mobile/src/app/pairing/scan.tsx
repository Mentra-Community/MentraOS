import {type Device, type DeviceModel} from "@mentra/bluetooth-sdk"
import {toolkit} from "@mentra/island"
import {useLocalSearchParams} from "expo-router"
import {useEffect, useState} from "react"
import {ActivityIndicator, Image, Platform, ScrollView, TouchableOpacity, View} from "react-native"

import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {Icon, Button, Header, Screen, Text} from "@/components/ignite"
import GlassesTroubleshootingModal from "@/components/glasses/GlassesTroubleshootingModal"
import Divider from "@/components/ui/Divider"
import {Group} from "@/components/ui/Group"
import {focusEffectPreventBack, usePushUnder} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useToolkitSnapshot} from "@/hooks/useToolkitSnapshot"
import {translate} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"
import showAlert from "@/utils/AlertUtils"
import {PermissionFeatures, requestFeaturePermissions} from "@/utils/PermissionsUtils"
import {getGlassesOpenImage} from "@/utils/getGlassesImage"
import GlassView from "@/components/ui/GlassView"

export default function SelectGlassesBluetoothScreen() {
  const {deviceModel} = useLocalSearchParams() as {deviceModel: DeviceModel}
  const {theme} = useAppTheme()
  const {goBack, replace, push} = useNavigationStore.getState()
  const pushUnder = usePushUnder()
  const [showTroubleshootingModal, setShowTroubleshootingModal] = useState(false)
  const bluetoothClassicConnected = useToolkitSnapshot(toolkit.pairing.readiness, (onChange) =>
    toolkit.pairing.onReadiness(onChange),
  ).bluetoothClassicConnected
  const searchResults = useToolkitSnapshot(toolkit.pairing.searchResults, (onChange) =>
    toolkit.pairing.onFound(onChange),
  )
  const [rememberedSearchResults, setRememberedSearchResults] = useState<Device[]>(searchResults)

  useEffect(() => {
    // Two-phase identity: reaching the scan screen marks the chosen model as the
    // PENDING selection. Promotion to `paired` only happens natively when pairing
    // succeeds; until then the home card renders a finish-pairing affordance.
    toolkit.pairing.markPendingSelection(deviceModel)
  }, [])

  // useFocusEffect(
  //   useCallback(() => {
  //     setRememberedSearchResults([])
  //   }, [setRememberedSearchResults]),
  // )

  focusEffectPreventBack((event) => {
    // Skip cleanup when navigating forward (e.g. replace() to btclassic) —
    // only run on actual back navigation.
    if (event && event.actionType !== "GO_BACK" && event.actionType !== "POP") {
      return
    }
    // Non-destructive back-out: abandonAttempt decides from the LIVE hydrated
    // default-device read — a re-pair's existing pairing survives, and so does
    // a pairing that PROMOTED while this flow was open (glasses can finish
    // pairing even when the user backs out of the UI). Only a genuinely
    // unpaired attempt forgets. The pending marker survives either way.
    void toolkit.pairing.abandonAttempt().catch((error) => {
      console.warn("Pairing scan back-out cleanup failed:", error)
    })
    goBack()
  }, true)

  useEffect(() => {
    const skipDevice = searchResults.find((result) => result.name === "NOTREQUIREDSKIP")
    if (skipDevice) {
      triggerGlassesPairingGuide(skipDevice)
      return
    }
  }, [searchResults])

  useEffect(() => {
    const initializeAndSearchForDevices = async () => {
      try {
        await toolkit.pairing.scan(deviceModel)
      } catch (error) {
        console.error("Failed to start glasses scan:", error)
      }
    }

    void initializeAndSearchForDevices()
  }, [])

  const triggerGlassesPairingGuide = async (device: Device) => {
    if (Platform.OS === "android") {
      const hasLocationPermission = await requestFeaturePermissions(PermissionFeatures.LOCATION)

      if (!hasLocationPermission) {
        showAlert(
          "Location Permission Required",
          "Location permission is required to scan for and connect to smart glasses on Android. This is a requirement of the Android Bluetooth system.",
          [{text: "OK"}],
        )
        return
      }
    }

    const hasMicPermission = await requestFeaturePermissions(PermissionFeatures.MICROPHONE)

    if (!hasMicPermission) {
      showAlert(
        "Microphone Permission Required",
        "Microphone permission is required to connect to smart glasses. Voice control and audio features are essential for the AR experience.",
        [{text: "OK"}],
      )
      return
    }

    await startPairing(device)
  }

  const startPairing = async (device: Device) => {
    const deviceTypesWithBtClassic = [DeviceTypes.LIVE]
    if (
      Platform.OS === "android" ||
      bluetoothClassicConnected ||
      !deviceTypesWithBtClassic.includes(device.model as DeviceTypes)
    ) {
      setTimeout(() => {
        toolkit.pairing.pair(device).catch((error) => {
          console.error("Failed to connect to glasses:", error)
        })
      }, 2000)
      push("/pairing/loading", {deviceModel: device.model, deviceName: device.name})
      // push("/pairing/success", {deviceModel: deviceModel})
      return
    }

    // pair bt classic first — thread the device through the route; the connect
    // (and the on-success default promotion) happens after BT Classic links.
    replace("/pairing/btclassic", {device: JSON.stringify(device)})
    pushUnder("/pairing/loading", {deviceModel: device.model, deviceName: device.name})
  }

  const filterDeviceName = (deviceName: string) => {
    let newName = deviceName.replace("MENTRA_LIVE_BLE_", "")
    newName = newName.replace("MENTRA_LIVE_BT_", "")
    newName = newName.replace("Mentra_Live_", "")
    newName = newName.replace("MENTRA_LIVE_", "")
    newName = newName.replace("MENTRA_DISPLAY_", "")
    return newName
  }

  // remember the search results to ensure consistent ordering:
  useEffect(() => {
    setRememberedSearchResults((prev) => {
      const combined = [...prev]
      for (const result of searchResults) {
        // if the device model is not our current device model, skip it:
        if (result.model !== deviceModel) {
          continue
        }
        if (!combined.some((r) => r.id === result.id)) {
          combined.push(result)
        }
      }
      return combined
    })
  }, [searchResults])

  const visibleResults = rememberedSearchResults.filter((r) => r.name !== "NOTREQUIREDSKIP" && r.model === deviceModel)

  return (
    <Screen preset="fixed" safeAreaEdges={["bottom"]} extraAndroidInsets>
      <Header leftIcon="chevron-left" onLeftPress={goBack} RightActionComponent={<MentraLogoStandalone />} />
      <View className="flex-1 justify-center">
        <GlassView className="gap-6 rounded-3xl p-6 bg-primary-foreground" transparent={false}>
          <Image
            source={getGlassesOpenImage(deviceModel)}
            className="h-[90px] w-[156px] mx-auto"
            resizeMode="contain"
          />
          <Text
            className="text-center text-xl font-semibold text-text-dim"
            text={translate("pairing:scanningForGlassesModel", {model: deviceModel})}
          />

          {visibleResults.length === 0 ? (
            <View className="justify-center min-h-20 py-4">
              <ActivityIndicator size="large" color={theme.colors.foreground} />
            </View>
          ) : (
            <ScrollView className="max-h-[300px] -mr-4 pr-4" contentContainerClassName="my-4">
              <Group>
                {visibleResults.map((res: Device) => {
                  let deviceName = filterDeviceName(res.name)

                  return (
                    <View
                      key={res.id}
                      className="flex-row items-center justify-between px-4 py-3 bg-primary-foreground">
                      <TouchableOpacity className="flex-1" onPress={() => triggerGlassesPairingGuide(res)}>
                        <View className="flex-1 px-2.5 flex-col">
                          <Text text={deviceModel} className="flex-wrap text-sm font-semibold" numberOfLines={2} />
                          <Text text={deviceName} className="text-xs text-muted-foreground" numberOfLines={1} />
                        </View>
                      </TouchableOpacity>
                      <Icon name="chevron-right" size={24} color={theme.colors.text} />
                    </View>
                  )
                })}
              </Group>
            </ScrollView>
          )}
          <Divider />
          <View className="flex-row justify-end">
            <Button preset="primary" compact tx="common:cancel" onPress={() => goBack()} className="min-w-[100px]" />
          </View>
        </GlassView>
      </View>
      <Button
        preset="secondary"
        tx="pairing:needMoreHelp"
        onPress={() => setShowTroubleshootingModal(true)}
        className="w-full"
      />
      <GlassesTroubleshootingModal
        isVisible={showTroubleshootingModal}
        onClose={() => setShowTroubleshootingModal(false)}
        deviceModel={deviceModel}
      />
    </Screen>
  )
}
